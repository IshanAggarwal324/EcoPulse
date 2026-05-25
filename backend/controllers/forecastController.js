const EnergyReading = require('../models/EnergyReading');
const asyncHandler = require('../utils/asyncHandler');

const getForecast = asyncHandler(async (req, res) => {
  const aiServiceUrl = process.env.AI_SERVICE_URL || 'http://localhost:8000';
  const daysToPredict = parseInt(req.query.days || '7', 10);
  const forceDummy = req.query.useDummy === 'true';

  let useDummyData = forceDummy;
  if (!forceDummy) {
    const readingCount = await EnergyReading.countDocuments();
    useDummyData = readingCount < 30;
  }

  let response;
  try {
    response = await fetch(`${aiServiceUrl}/forecast/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        days_to_predict: daysToPredict,
        use_dummy_data: useDummyData,
      }),
    });
  } catch (error) {
    return res.status(503).json({
      success: false,
      message: 'AI service unavailable',
      details: error.message,
    });
  }

  if (!response.ok) {
    const errorText = await response.text();
    return res.status(response.status).json({
      success: false,
      message: 'Error communicating with AI service',
      details: errorText,
    });
  }

  const data = await response.json();

  res.status(200).json({
    ...data,
    meta: {
      useDummyData,
      daysToPredict,
    },
  });
});

module.exports = {
  getForecast,
};
