// Increase the default timeout for tests to avoid timeouts in CI
jest.setTimeout(30000);

// Add custom matchers if needed
// Example:
// expect.extend({
//   toBeWithinRange(received, floor, ceiling) {
//     const pass = received >= floor && received <= ceiling;
//     if (pass) {
//       return {
//         message: () => `expected ${received} not to be within range ${floor} - ${ceiling}`,
//         pass: true,
//       };
//     } else {
//       return {
//         message: () => `expected ${received} to be within range ${floor} - ${ceiling}`,
//         pass: false,
//       };
//     }
//   },
// });

// Mock any global dependencies here
// Example:
// global.fetch = jest.fn(() => Promise.resolve({
//   json: () => Promise.resolve({})
// }));

// Any other global setup needed for all tests 