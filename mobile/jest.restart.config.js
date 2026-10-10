const base = require('./jest.config.js');
module.exports = {...base, testMatch: ['<rootDir>/restart-tests/*.test.tsx']};
