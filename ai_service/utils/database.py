import pandas as pd
import numpy as np
from datetime import datetime, timedelta
from typing import Optional
import motor.motor_asyncio
import os
from bson import ObjectId
from bson.errors import InvalidId
from dotenv import load_dotenv

load_dotenv()

MONGO_URI = os.getenv("MONGODB_URI", os.getenv("MONGO_URI", "mongodb://localhost:27017"))
client = motor.motor_asyncio.AsyncIOMotorClient(MONGO_URI)
db = client.ecopulse
# Mongoose default collection name for EnergyReading model
readings_collection = db.energyreadings
# Sub-module 1.3.5 — MongoDB time-series collection + hourly rollup.
# When USE_TIMESERIES=true, the AI read path queries these instead of the
# legacy collection, using server-side downsampling for the LSTM window.
ts_collection = db.energyreadings_ts
hourly_collection = db.energyreadings_hourly

# Whether the time-series read path is active. When true, the AI service reads
# from the time-series collection (server-side $dateTrunc downsampling) and
# falls back to hourly rollups for history older than the raw TTL.
USE_TIMESERIES = os.getenv("USE_TIMESERIES", "false").lower() == "true"
# Lookback window for the LSTM input (days). Matches the backend default.
FORECAST_LOOKBACK_DAYS = int(os.getenv("FORECAST_LOOKBACK_DAYS", "60"))
# Raw readings expire after this many days (must match backend TIMESERIES_RAW_TTL_DAYS).
RAW_TTL_DAYS = int(os.getenv("TIMESERIES_RAW_TTL_DAYS", "90"))

def _dummy_seed(node_id: Optional[str]) -> int:
    if not node_id:
        return 42
    return abs(hash(node_id)) % (2**31 - 1)


async def get_historical_data_timeseries(
    days: int = FORECAST_LOOKBACK_DAYS,
    node_id: Optional[str] = None,
) -> pd.DataFrame:
    """Sub-module 1.3.5 — time-series read path with server-side downsampling.

    Reads from `energyreadings_ts` for the recent raw window and stitches in
    pre-materialized hourly rollups (`energyreadings_hourly`) for history
    older than the raw TTL, so the LSTM always sees a continuous daily series
    regardless of the 90-day raw expiry.
    """
    end_date = datetime.now()
    start_date = end_date - timedelta(days=days)

    # --- 1. Raw time-series window, downsampled server-side to daily ---
    raw_start = end_date - timedelta(days=min(days, RAW_TTL_DAYS))
    raw_pipeline = [
        {"$match": {"timestamp": {"$gte": raw_start, "$lte": end_date}}},
        {
            "$group": {
                "_id": {"$dateTrunc": {"date": "$timestamp", "unit": "day", "timezone": "UTC"}},
                "generation": {"$sum": "$energyGenerated"},
                "consumption": {"$sum": "$energyConsumed"},
            }
        },
        {"$sort": {"_id": 1}},
    ]
    if node_id:
        try:
            raw_pipeline[0]["$match"]["meta.nodeId"] = ObjectId(node_id)
        except InvalidId:
            return pd.DataFrame(columns=['timestamp', 'generation', 'consumption']).set_index('timestamp')

    raw_rows = await ts_collection.aggregate(raw_pipeline).to_list(length=None)

    # --- 2. Hourly rollups for history beyond the raw TTL ---
    rollup_rows = []
    if days > RAW_TTL_DAYS:
        rollup_end = raw_start
        rollup_pipeline = [
            {"$match": {"hour": {"$gte": start_date, "$lt": rollup_end}}},
            {
                "$group": {
                    "_id": {
                        "$dateTrunc": {"date": "$hour", "unit": "day", "timezone": "UTC"}
                    },
                    "generation": {"$sum": "$energyGenerated"},
                    "consumption": {"$sum": "$energyConsumed"},
                }
            },
            {"$sort": {"_id": 1}},
        ]
        if node_id:
            try:
                rollup_pipeline[0]["$match"]["nodeId"] = ObjectId(node_id)
            except InvalidId:
                pass
        rollup_rows = await hourly_collection.aggregate(rollup_pipeline).to_list(length=None)

    combined = rollup_rows + raw_rows
    if not combined:
        return pd.DataFrame(columns=['timestamp', 'generation', 'consumption']).set_index('timestamp')

    df = pd.DataFrame([
        {"timestamp": row["_id"], "generation": row.get("generation", 0), "consumption": row.get("consumption", 0)}
        for row in combined
    ])
    df['timestamp'] = pd.to_datetime(df['timestamp'])
    df = df.groupby(df['timestamp'].dt.date).agg({'generation': 'sum', 'consumption': 'sum'}).reset_index()
    df['timestamp'] = pd.to_datetime(df['timestamp'])
    df = df[['timestamp', 'generation', 'consumption']].set_index('timestamp')
    return df


async def get_historical_data(
    use_dummy: bool = False,
    days: int = FORECAST_LOOKBACK_DAYS,
    node_id: Optional[str] = None,
) -> pd.DataFrame:
    # Sub-module 1.3.5 — route to the time-series read path when enabled.
    if not use_dummy and USE_TIMESERIES:
        return await get_historical_data_timeseries(days=days, node_id=node_id)

    if use_dummy:
        end_date = datetime.now()
        start_date = end_date - timedelta(days=days)
        date_rng = pd.date_range(start=start_date, end=end_date, freq='D')

        seed = _dummy_seed(node_id)
        np.random.seed(seed)
        phase = (seed % 120) / 365.0
        scale = 0.85 + (seed % 30) / 100.0
        generation = scale * (
            1000
            + 200 * np.sin(np.arange(len(date_rng)) * (2 * np.pi / 365) + phase)
            + np.random.normal(0, 50, len(date_rng))
        )
        consumption = scale * (
            900
            + 150 * np.cos(np.arange(len(date_rng)) * (2 * np.pi / 365) + phase)
            + np.random.normal(0, 40, len(date_rng))
        )

        df = pd.DataFrame(date_rng, columns=['timestamp'])
        df['generation'] = generation
        df['consumption'] = consumption
        df.set_index('timestamp', inplace=True)
        return df

    end_date = datetime.now()
    start_date = end_date - timedelta(days=days)

    query = {"timestamp": {"$gte": start_date, "$lte": end_date}}
    if node_id:
        try:
            query["nodeId"] = ObjectId(node_id)
        except InvalidId:
            return pd.DataFrame(columns=['timestamp', 'generation', 'consumption']).set_index('timestamp')

    pipeline = [
        {"$match": query},
        {
            "$group": {
                "_id": {"$dateTrunc": {"date": "$timestamp", "unit": "day", "timezone": "UTC"}},
                "generation": {"$sum": "$energyGenerated"},
                "consumption": {"$sum": "$energyConsumed"},
            }
        },
        {"$sort": {"_id": 1}},
    ]

    rows = await readings_collection.aggregate(pipeline).to_list(length=None)

    if not rows:
        return pd.DataFrame(columns=['timestamp', 'generation', 'consumption']).set_index('timestamp')

    daily = pd.DataFrame([
        {
            "timestamp": row["_id"],
            "generation": row.get("generation", 0),
            "consumption": row.get("consumption", 0),
        }
        for row in rows
    ])
    daily['timestamp'] = pd.to_datetime(daily['timestamp'])
    daily = daily[['timestamp', 'generation', 'consumption']].set_index('timestamp')
    return daily
