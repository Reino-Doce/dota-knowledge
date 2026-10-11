export interface AcquiredProviderArtifact {
    readonly providerId: string;
    readonly bytes: Uint8Array;
    readonly byteLength: number;
    readonly sha256: string;
    readonly retrievedAt: string;
    readonly contentType: string | null;
}
export function acquireProviderArtifact(options: {
    readonly providerId: string;
    readonly client: (request: unknown, options: { signal: AbortSignal; credentials?: unknown }) => Promise<Response>;
    readonly request: unknown;
    readonly credentials?: unknown;
    readonly timeoutMs?: number;
    readonly maxBytes?: number;
    readonly clock?: () => Date;
}): Promise<AcquiredProviderArtifact>;
