# EcoPulse Forecasts Explained

## What is energy forecasting?

Energy forecasting predicts future energy generation and consumption for the EcoPulse grid. The platform uses an LSTM (Long Short-Term Memory) neural network trained on historical energy readings to produce forecasts for up to 90 days ahead. Forecasts help users anticipate grid behavior, plan energy trading, and understand trends in renewable energy output.

## How does the LSTM model work?

The forecasting model is a recurrent neural network with two LSTM layers (50 units each) separated by dropout regularization (0.2) to prevent overfitting. The model takes a window of historical daily generation and consumption values as input and predicts the next day's values.

For multi-step forecasting, the model uses a recursive approach: it predicts one day ahead, appends that prediction to the input window, drops the oldest day, and repeats. This rolling prediction continues for the requested number of days (up to 90). Each prediction includes both generation and consumption values.

The model is trained using the Adam optimizer with mean squared error loss. Training data is split chronologically (80% train, 10% validation, 10% test) to preserve time-series integrity and avoid data leakage.

## What data does the model use?

The model uses historical energy readings from the `energyreadings` MongoDB collection. Readings are aggregated to daily totals by summing all generation and consumption values for each day. If there are gaps in the data, they are filled using forward-fill then back-fill to ensure a continuous daily time series.

Before training, the data is normalized using MinMaxScaler fitted only on the training set. This scaling ensures the neural network receives inputs in a stable range (0 to 1). Predictions are inverse-transformed back to original kWh values before being returned to the user.

The default look-back window is 30 days, meaning the model looks at the past 30 days of data to predict the next day. This window can be configured.

## What do the confidence bands mean?

Each forecast prediction includes confidence bands that represent the estimated uncertainty of the prediction. Narrower bands indicate higher confidence, while wider bands indicate lower confidence.

Confidence bands typically widen for predictions further into the future because uncertainty accumulates with each recursive prediction step. A 1-day forecast will have tighter bands than a 30-day forecast.

The confidence score is a numerical value (0 to 1) summarizing the model's certainty. Higher scores indicate more reliable predictions. The confidence depends on factors like the amount of training data available, the consistency of historical patterns, and how far into the future the prediction extends.

## How do I view forecasts?

Navigate to the Forecasts page in the sidebar. There are three view modes:

- **Aggregate**: Shows network-wide predictions combining data from all nodes. This gives an overall picture of the grid's expected generation and consumption.
- **Single Node**: Select a specific node from the dropdown to see forecasts for just that node. Useful for checking a particular solar farm or wind turbine.
- **Compare All**: Displays forecasts for all nodes side by side in a comparison grid. Useful for identifying which nodes are expected to produce the most energy.

Each view shows 7-day predictions by default with generation and consumption lines and shaded confidence bands. Summary cards display the average predicted generation, average predicted consumption, and average confidence score.

## How accurate are the forecasts?

Forecast accuracy depends on several factors:

- **Training data volume**: More historical readings lead to better model performance. The model needs at least 30 days of daily data to make reasonable predictions.
- **Data consistency**: Regular, gap-free readings produce more reliable forecasts. The system fills gaps automatically, but large gaps reduce accuracy.
- **Forecast horizon**: Short-term predictions (1-7 days) are generally more accurate than long-term predictions (30-90 days). Uncertainty accumulates with each recursive step.
- **Pattern regularity**: Nodes with consistent diurnal patterns (like solar farms) are easier to forecast than highly variable sources.

When the LSTM model is unavailable (no trained model artifacts), the system falls back to heuristic predictions based on recent moving averages with a linear trend. These fallback predictions have lower confidence scores and should be treated as rough estimates.

## What happens when the AI service is down?

If the AI forecasting service (port 8000) is unreachable or has no trained model, the forecast system does not return an error. Instead, it generates fallback predictions using a heuristic approach:

1. Calculates a moving average of recent energy readings.
2. Applies a linear trend based on recent data direction.
3. Adds decreasing confidence as the forecast extends further.

The response includes a `model_status` field indicating whether the prediction came from the LSTM model or the fallback heuristic. The frontend displays this status so users know the reliability level of the data they are viewing.

## Can I forecast for a single node?

Yes. On the Forecasts page, switch to the "Single Node" view and select a node from the dropdown. The API supports per-node forecasting by passing a `node_id` parameter. The model loads historical readings filtered to that specific node and generates predictions.

Per-node forecasts are useful for monitoring individual solar farms, wind turbines, or other assets. They can help you decide when to list energy for sale based on expected generation, or plan consumption based on predicted output.

## What is the batch forecast endpoint?

The AI service provides a batch forecast endpoint (`POST /forecast/batch`) that generates predictions for multiple nodes in a single request. This is used by the "Compare All" view on the Forecasts page to efficiently load forecasts for all nodes without making separate API calls for each one.

The batch endpoint handles partial errors gracefully. If one node fails to produce a forecast (for example, due to insufficient data), the remaining nodes' forecasts are still returned successfully.

## How are forecasts used in reports?

When you generate a report through the AI assistant, an optional forecast outlook section can be included. This section summarizes the 7-day energy forecast, highlighting expected generation and consumption trends. The forecast data is fetched from the AI service and included in the report metrics before being narrated by the GenAI service.

The forecast outlook is labeled as a prediction and includes the confidence level so report readers understand the uncertainty involved.

## What is the forecast API endpoint?

The backend proxies forecast requests to the AI service at `GET /api/v1/forecast`. This endpoint accepts query parameters for the number of days to predict (1-90, default 7), whether to use dummy data, and an optional node ID.

The response includes an array of predictions, each with a timestamp, predicted generation (kWh), predicted consumption (kWh), confidence bands (upper and lower), and a confidence score. The response also includes model status and version information.
