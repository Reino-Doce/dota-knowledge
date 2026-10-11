export interface VpkArchive {
    readonly files: readonly string[];
    read(resourcePath: string): Buffer;
}
export function openVpk(filename: string): VpkArchive;
export type KeyValuesObject = Record<string, string | KeyValuesObject>;
export function parseKeyValues(text: string): KeyValuesObject;
export function resolveGameDirectory(input?: string): string;
