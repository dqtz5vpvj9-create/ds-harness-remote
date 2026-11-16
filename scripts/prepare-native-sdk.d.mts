export function verifySdkBytes(data: Uint8Array, expected: string): void;
export function prepareNativeSdk(directory: string, archivePath?: string): Promise<{ extension: string; packages: number; linkedSdkPackages: number }>;
