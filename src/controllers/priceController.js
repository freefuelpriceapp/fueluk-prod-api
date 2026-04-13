const priceRepository = require('../repositories/priceRepository');

/**
 * GET /api/v1/prices/station/:stationId
 * Get all prices for a specific station
 */
async function getPricesByStation(req, res, next) {
  try {
    const { stationId } = req.params;
    const { fuel_type } = req.query;

    if (!stationId) {
      return res.status(400).json({
        success: false,
        error: 'Bad request',
        message: 'stationId is required',
      });
    }

    const prices = await priceRepository.getPricesByStation({
      stationId: parseInt(stationId),
      fuelType: fuel_type || null,
    });

    return res.json({
      success: true,
      count: prices.length,
      prices,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/v1/prices
 * Submit a new price report
 */
async function submitPrice(req, res, next) {
  try {
    const { station_id, fuel_type, price_pence, source = 'user' } = req.body;

    if (!station_id || !fuel_type || !price_pence) {
      return res.status(400).json({
        success: false,
        error: 'Bad request',
        message: 'station_id, fuel_type, and price_pence are required',
      });
    }

    if (typeof price_pence !== 'number' || price_pence < 50 || price_pence > 300) {
      return res.status(400).json({
        success: false,
        error: 'Bad request',
        message: 'price_pence must be a number between 50 and 300',
      });
    }

    const validFuelTypes = ['unleaded', 'diesel', 'super_unleaded', 'premium_diesel'];
    if (!validFuelTypes.includes(fuel_type)) {
      return res.status(400).json({
        success: false,
        error: 'Bad request',
        message: `fuel_type must be one of: ${validFuelTypes.join(', ')}`,
      });
    }

    const price = await priceRepository.insertPrice({
      stationId: parseInt(station_id),
      fuelType: fuel_type,
      pricePence: price_pence,
      source,
    });

    return res.status(201).json({
      success: true,
      price,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/prices/latest
 * Get latest prices across all stations, optionally filtered by fuel_type
 */
async function getLatestPrices(req, res, next) {
  try {
    const { fuel_type, limit = 50 } = req.query;

    const prices = await priceRepository.getLatestPrices({
      fuelType: fuel_type || null,
      limit: parseInt(limit),
    });

    return res.json({
      success: true,
      count: prices.length,
      prices,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { getPricesByStation, submitPrice, getLatestPrices };
