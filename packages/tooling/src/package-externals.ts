export interface PackageDependencyManifest {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
}

function escapeRegExp(input: string): string {
    return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Returns exact and subpath matches for dependencies that a library consumer must provide.
 */
export function packageDependencyExternals(manifest: PackageDependencyManifest): Array<string | RegExp> {
    const names = new Set<string>([
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.optionalDependencies ?? {}),
        ...Object.keys(manifest.peerDependencies ?? {})
    ]);

    return Array.from(names).flatMap(name => [name, new RegExp(`^${escapeRegExp(name)}/`)]);
}
