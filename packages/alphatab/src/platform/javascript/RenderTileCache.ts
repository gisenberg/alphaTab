/** Statistics for the detached score-tile cache. */
export interface RenderTileCacheStats {
    tileCount: number;
    elementCount: number;
}

interface RenderTileCacheEntry<T> {
    value: T;
    elementCount: number;
}

/**
 * A strictly bounded LRU for detached score-rendering tiles.
 * @internal
 */
export class RenderTileCache<T> {
    private readonly _entries: Map<string, RenderTileCacheEntry<T>> = new Map();
    private _elementCount: number = 0;

    public constructor(
        private _tileLimit: number,
        private _elementLimit: number
    ) {}

    public configure(tileLimit: number, elementLimit: number): string[] {
        this._tileLimit = Math.max(0, tileLimit);
        this._elementLimit = Math.max(0, elementLimit);
        return this._trim();
    }

    public set(key: string, value: T, elementCount: number): string[] {
        this.delete(key);
        this._entries.set(key, { value, elementCount: Math.max(0, elementCount) });
        this._elementCount += Math.max(0, elementCount);
        return this._trim();
    }

    public take(key: string): T | undefined {
        const entry = this._entries.get(key);
        if (!entry) {
            return undefined;
        }
        this._entries.delete(key);
        this._elementCount -= entry.elementCount;
        return entry.value;
    }

    public delete(key: string): boolean {
        const entry = this._entries.get(key);
        if (!entry) {
            return false;
        }
        this._entries.delete(key);
        this._elementCount -= entry.elementCount;
        return true;
    }

    public clear(): void {
        this._entries.clear();
        this._elementCount = 0;
    }

    public get stats(): RenderTileCacheStats {
        return {
            tileCount: this._entries.size,
            elementCount: this._elementCount
        };
    }

    private _trim(): string[] {
        const evicted: string[] = [];
        while (this._entries.size > this._tileLimit || this._elementCount > this._elementLimit) {
            const oldest = this._entries.entries().next();
            if (oldest.done) {
                break;
            }
            const [key, entry] = oldest.value;
            this._entries.delete(key);
            this._elementCount -= entry.elementCount;
            evicted.push(key);
        }
        return evicted;
    }
}
