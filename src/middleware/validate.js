const ApiError = require('../utils/ApiError');

/**
 * Generic validation middleware factory.
 * @param {Function} validatorFn - Function receiving req that returns an array of error messages or { errors: [...] }
 */
const validate = (validatorFn) => {
  return (req, res, next) => {
    try {
      const result = validatorFn(req);

      // Support returning an array of errors or an object { isValid, errors }
      let errors = [];
      if (Array.isArray(result)) {
        errors = result;
      } else if (result && Array.isArray(result.errors)) {
        errors = result.errors;
      }

      if (errors.length > 0) {
        return res.status(400).json({
          success: false,
          status: 'fail',
          message: 'Validation failed',
          errors
        });
      }

      next();
    } catch (err) {
      next(err);
    }
  };
};

module.exports = validate;
