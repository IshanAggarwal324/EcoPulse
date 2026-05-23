import pandas as pd
import numpy as np
from datetime import datetime, timedelta

def get_historical_data(use_dummy: bool = True, days: int = 365) -> pd.DataFrame:
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
        # Placeholder for actual MongoDB loading logic
        # client = motor.motor_asyncio.AsyncIOMotorClient("mongodb://localhost:27017")
        # db = client.ecopulse
        # collection = db.readings
        # ... fetch and convert to DataFrame
        raise NotImplementedError("MongoDB integration not yet implemented. Use dummy data.")
