/**
 * notFound.js
 * 404 Not Found middleware for fueluk-prod-api.
 * Catches any request that didn't match a registered route.
 */

module.exports = function notFound(req, res, next) {
  res.status(404).json({
    success: false,
    error: 'Not found',
    message: `Cannot ${req.method} ${req.originalUrl}`,
    statusCode: 404,
  });
};
