import pandas as pd
import numpy as np
from datetime import datetime, timedelta
import motor.motor_asyncio
import os
from dotenv import load_dotenv

load_dotenv()

MONGO_URI = os.getenv("MONGODB_URI", "mongodb://localhost:27017")
client = motor.motor_asyncio.AsyncIOMotorClient(MONGO_URI)
db = client.ecopulse
readings_collection = db.readings

async def get_historical_data(use_dummy: bool = False, days: int = 365) -> pd.DataFrame:
    if use_dummy:
        # Generate dummy data
        end_date = datetime.now()
        start_date = end_date - timedelta(days=days)
        date_rng = pd.date_range(start=start_date, end=end_date, freq='D')
        
        # Base generation with some seasonality
        np.random.seed(42)
        generation = 1000 + 200 * np.sin(np.arange(len(date_rng)) * (2 * np.pi / 365)) + np.random.normal(0, 50, len(date_rng))
        
        # Base consumption with different seasonality
        consumption = 900 + 150 * np.cos(np.arange(len(date_rng)) * (2 * np.pi / 365)) + np.random.normal(0, 40, len(date_rng))
        
        df = pd.DataFrame(date_rng, columns=['timestamp'])
        df['generation'] = generation
        df['consumption'] = consumption
        df.set_index('timestamp', inplace=True)
        return df
    else:
        # Fetch actual data from MongoDB
        end_date = datetime.now()
        start_date = end_date - timedelta(days=days)
        
        cursor = readings_collection.find({
            "timestamp": {"$gte": start_date, "$lte": end_date}
        }).sort("timestamp", 1)
        
        documents = await cursor.to_list(length=None)
        
        if not documents:
            # Fallback to empty dataframe with correct columns if no data
            return pd.DataFrame(columns=['timestamp', 'generation', 'consumption']).set_index('timestamp')
            
        df = pd.DataFrame(documents)
        
        # Ensure we just keep the fields we need
        df = df[['timestamp', 'generation', 'consumption']]
        df.set_index('timestamp', inplace=True)
        
        # Handle potential missing days/resampling here if needed
        # df = df.resample('D').mean().interpolate()
        
        return df
