const getForecast = async (req, res, next) => {
  try {
    const aiServiceUrl = process.env.AI_SERVICE_URL || 'http://localhost:8000';
    
    // Default to predicting next 7 days, using dummy data for now
    // In production, the AI service will be configured to use real data
    const response = await fetch(`${aiServiceUrl}/forecast/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        days_to_predict: 7,
        use_dummy_data: true
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({
        message: 'Error communicating with AI service',
        details: errorText
      });
    }

    const data = await response.json();
    res.status(200).json(data);
  } catch (error) {
    console.error('Forecast Controller Error:', error);
    next(new Error('Failed to fetch forecast from AI Service. Ensure the AI service is running on port 8000.'));
  }
};

module.exports = {
  getForecast
};
