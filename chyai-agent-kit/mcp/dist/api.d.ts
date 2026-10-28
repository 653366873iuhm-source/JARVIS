/** Minimal read client for the public ChyAI API. No keys, no signing, no transaction sending. */
export declare const DEFAULT_API_ROOT = "https://agentpad-api.onrender.com";
export declare const SITE_URL = "https://chyai.onrender.com";
export declare const PINNED_POST = "https://x.com/ChyAI_Official/status/2115430735167607129";
export declare class ChyAIApiError extends Error {
    readonly status: number;
    readonly code: string;
    readonly body?: unknown | undefined;
    constructor(status: number, code: string, message: string, body?: unknown | undefined);
}
export interface ChyAIClientOptions {
    /** API host without /v1 (default https://agentpad-api.onrender.com, env CHYAI_API_URL). */
    apiRoot?: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
}
export declare class ChyAIClient {
    readonly apiRoot: string;
    private readonly f;
    private readonly timeoutMs;
    constructor(opts?: ChyAIClientOptions);
    get v1(): string;
    /** GET a path under the API root. JSON bodies are parsed; text bodies returned as string. 4xx/5xx throw. */
    get(path: string, okStatuses?: number[]): Promise<unknown>;
    config(): Promise<unknown>;
    health(): Promise<unknown>;
    agentFlow(wallet: string): Promise<unknown>;
    agentPrompt(ref?: string): Promise<unknown>;
    agentInstructions(): Promise<string>;
    llmsTxt(): Promise<string>;
    airdropStatus(wallet: string): Promise<unknown>;
    mintVoucher(wallet: string): Promise<unknown>;
    mining(wallet: string): Promise<unknown>;
    miningStats(): Promise<unknown>;
    miningLeaderboard(): Promise<unknown>;
    invites(wallet: string): Promise<unknown>;
    rewardsProof(wallet: string): Promise<unknown>;
}
export interface ClaimInput {
    xHandle: string;
    wallet: string;
    agentName: string;
    repostUrl: string;
    ref?: string;
}
/** Validates and normalises a POST /v1/airdrop/claim body. Throws Error with a readable message on bad input. */
export declare function buildClaimPayload(p: ClaimInput): {
    ref?: string | undefined;
    xHandle: string;
    wallet: string;
    agentName: string;
    repostUrl: string;
};
