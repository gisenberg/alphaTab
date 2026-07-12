import { describe, expect, it } from 'vitest';
import { packageDependencyExternals } from '../src/package-externals';

describe('packageDependencyExternals', () => {
    it('matches runtime, optional, and peer dependencies including subpaths', () => {
        const externals = packageDependencyExternals({
            dependencies: { 'magic-string': '^1' },
            optionalDependencies: { sharp: '^1' },
            peerDependencies: { '@scope/runtime': '^1' }
        });
        const isExternal = (id: string) =>
            externals.some(external => (typeof external === 'string' ? external === id : external.test(id)));

        expect(isExternal('magic-string')).toBe(true);
        expect(isExternal('magic-string/internal')).toBe(true);
        expect(isExternal('sharp')).toBe(true);
        expect(isExternal('@scope/runtime/plugin')).toBe(true);
        expect(isExternal('unlisted-package')).toBe(false);
    });
});
