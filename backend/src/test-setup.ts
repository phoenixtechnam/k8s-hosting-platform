// Global test setup
// Sets default env vars for tests

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-key-for-testing-only';
process.env.DATABASE_URL ??= 'postgresql://platform:platform@localhost:5432/hosting_platform_test';
process.env.PORT = '0'; // random port for tests
