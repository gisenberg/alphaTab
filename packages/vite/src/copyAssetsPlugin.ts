import fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';
import type { AlphaTabVitePluginOptions } from './AlphaTabVitePluginOptions';
import type { Plugin, ResolvedConfig } from './bridge';

/**
 * @public
 */
export function copyAssetsPlugin(options: AlphaTabVitePluginOptions): Plugin {
    let resolvedConfig: ResolvedConfig;
    let output = false;
    let resolvedAlphaTabSourceDir: string | undefined;

    async function resolveAlphaTabSourceDir(): Promise<string | undefined> {
        if (resolvedAlphaTabSourceDir) {
            return resolvedAlphaTabSourceDir;
        }

        let alphaTabSourceDir = options.alphaTabSourceDir;
        if (!alphaTabSourceDir) {
            try {
                const isEsm = typeof import.meta.url === 'string';
                if (isEsm) {
                    alphaTabSourceDir = url.fileURLToPath(import.meta.resolve('@coderline/alphatab'));
                } else {
                    alphaTabSourceDir = require.resolve('@coderline/alphatab');
                }

                alphaTabSourceDir = path.resolve(alphaTabSourceDir, '..');

                // walk up to package.json
                while (alphaTabSourceDir) {
                    if (
                        await fs.promises
                            .access(path.join(alphaTabSourceDir, 'package.json'), fs.constants.F_OK)
                            .then(() => true)
                            .catch(() => false)
                    ) {
                        // found package directory
                        alphaTabSourceDir = path.resolve(alphaTabSourceDir, 'dist');
                        break;
                    }

                    // reached root
                    const parent = path.resolve(alphaTabSourceDir, '..');
                    alphaTabSourceDir = parent === alphaTabSourceDir ? undefined : parent;
                }
            } catch {
                alphaTabSourceDir = path.join(resolvedConfig.root, 'node_modules/@coderline/alphatab/dist/');
            }
        }

        if (alphaTabSourceDir) {
            try {
                await fs.promises.access(path.join(alphaTabSourceDir, 'alphaTab.mjs'), fs.constants.F_OK);
                resolvedAlphaTabSourceDir = alphaTabSourceDir;
                return resolvedAlphaTabSourceDir;
            } catch {
                // handled by the shared error below
            }
        }

        resolvedConfig.logger.error(
            'Could not find alphaTab, please ensure it is installed into node_modules or configure alphaTabSourceDir'
        );
        return undefined;
    }

    return {
        name: 'vite-plugin-alphatab-copy',
        enforce: 'pre',
        configResolved(config) {
            resolvedConfig = config as ResolvedConfig;
        },
        async configureServer(server) {
            if (resolvedConfig.experimental?.bundledDev !== true) {
                return;
            }

            const alphaTabSourceDir = await resolveAlphaTabSourceDir();
            if (!alphaTabSourceDir) {
                return;
            }

            const base = resolvedConfig.base.startsWith('/') ? resolvedConfig.base : '/';
            const runtimePrefix = `${base.replace(/\/$/, '')}/alphatab/`;
            const runtimeFiles = new Set(['alphaTab.worker.mjs', 'alphaTab.worklet.mjs']);
            server.middlewares.use((request, response, next) => {
                const requestPath = request.url?.split('?', 1)[0];
                if (!requestPath?.startsWith(runtimePrefix)) {
                    next();
                    return;
                }

                const fileName = requestPath.slice(runtimePrefix.length);
                if (!runtimeFiles.has(fileName)) {
                    next();
                    return;
                }

                response.statusCode = 200;
                response.setHeader('Content-Type', 'text/javascript');
                response.setHeader('Cache-Control', 'no-cache');
                for (const [name, value] of Object.entries(resolvedConfig.server.headers ?? {})) {
                    if (value !== undefined) {
                        response.setHeader(name, value);
                    }
                }
                if (request.method === 'HEAD') {
                    response.end();
                    return;
                }

                const stream = fs.createReadStream(path.join(alphaTabSourceDir, fileName));
                stream.on('error', next);
                stream.pipe(response);
            });
        },
        buildEnd() {
            // reset for watch mode
            output = false;
        },
        async buildStart() {
            // run copy only once even if multiple bundles are generated
            if (output) {
                return;
            }
            output = true;

            const alphaTabSourceDir = await resolveAlphaTabSourceDir();
            if (!alphaTabSourceDir) {
                return;
            }

            const outputPath = (options.assetOutputDir ?? resolvedConfig.publicDir) as string;
            if (!outputPath) {
                return;
            }

            async function copyFiles(subdir: string): Promise<void> {
                const fullDir = path.join(alphaTabSourceDir!, subdir);

                const files = await fs.promises.readdir(fullDir, {
                    withFileTypes: true
                });

                await fs.promises.mkdir(path.join(outputPath, subdir), {
                    recursive: true
                });

                await Promise.all(
                    files
                        .filter(f => f.isFile())
                        .map(async file => {
                            // node v20.12.0 has parentPath pointing to the path (not the file)
                            // see https://github.com/nodejs/node/pull/50976
                            const sourceFilename = path.join(file.parentPath ?? (file as any).path, file.name);
                            await fs.promises.copyFile(sourceFilename, path.join(outputPath!, subdir, file.name));
                        })
                );
            }

            await Promise.all([copyFiles('font'), copyFiles('soundfont')]);
        }
    };
}
