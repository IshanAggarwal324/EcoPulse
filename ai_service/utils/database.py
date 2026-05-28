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

def _dummy_seed(node_id: Optional[str]) -> int:
    if not node_id:
        return 42
    return abs(hash(node_id)) % (2**31 - 1)


async def get_historical_data(
    use_dummy: bool = False,
    days: int = 365,
    node_id: Optional[str] = None,
) -> pd.DataFrame:
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

    cursor = readings_collection.find(query).sort("timestamp", 1)

    documents = await cursor.to_list(length=None)

    if not documents:
        return pd.DataFrame(columns=['timestamp', 'generation', 'consumption']).set_index('timestamp')

    df = pd.DataFrame(documents)

    df['generation'] = df.get('energyGenerated', df.get('generation', 0)).fillna(0)
    df['consumption'] = df.get('energyConsumed', df.get('consumption', 0)).fillna(0)
    df['timestamp'] = pd.to_datetime(df['timestamp'])

    daily = df.groupby(df['timestamp'].dt.date).agg({
        'generation': 'sum',
        'consumption': 'sum',
    }).reset_index()

    daily.rename(columns={'timestamp': 'date'}, inplace=True)
    daily['timestamp'] = pd.to_datetime(daily['date'])
    daily = daily[['timestamp', 'generation', 'consumption']]
    daily.set_index('timestamp', inplace=True)

    return daily
