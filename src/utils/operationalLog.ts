/** Never serialize Error.message, stack, request input, provider bodies or credentials. */
export function logOperationalError(operation: string, error?: unknown) {
    const raw = error && typeof error === 'object' && 'code' in error ? (error as {
        code?: unknown;
    }).code : undefined;
    const code = typeof raw === 'string' && (/^(P\d{4}|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ECONNRESET)$/.test(raw)) ? raw : 'UNCLASSIFIED';
    console.error(JSON.stringify({ event: 'operation_failed', operation, code }));
}
