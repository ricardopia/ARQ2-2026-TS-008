/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    // Some @nestjs/* packages ship ESM only; compile them to CommonJS for Jest.
    '^.+\\.[tj]s$': [
      'ts-jest',
      { tsconfig: { allowJs: true, module: 'commonjs', moduleResolution: 'node' } },
    ],
  },
  transformIgnorePatterns: ['/node_modules/(?!(@nestjs/config)/)'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  collectCoverageFrom: ['**/*.ts'],
  coverageDirectory: '../coverage',
  testEnvironment: 'node',
};
