import { defineConfig } from 'vitest/config'

export default defineConfig({
    // Mirror the webpack DefinePlugin so modules that read these build-time
    // globals can be imported under test.
    define: {
        __BUILT_FOR__: JSON.stringify('chrome'),
        __DEV__: JSON.stringify(true),
        __VERSION__: JSON.stringify('0.0.0'),
        __CHANGELOG__: JSON.stringify([]),
    },
    test: {
        environment: 'node',
        include: ['tests/unit/**/*.test.ts'],
    },
})
