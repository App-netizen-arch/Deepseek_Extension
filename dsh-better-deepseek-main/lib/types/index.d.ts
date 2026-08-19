import { Context, Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
declare module '@deepseek-ai/cordis' {
    interface Context {
        betterDeepSeekBridge: BetterDeepSeekBridgeService;
    }
}
export interface Config {
    enableCors?: boolean;
}
export declare class BetterDeepSeekBridgeService extends Service {
    private readonly config;
    static inject: string[];
    static Config: z<Config>;
    private readonly sseClients;
    private readonly latestAssistantTextBySession;
    constructor(ctx: Context, config: Config);
    private handleCors;
    private readJsonBody;
    private setupEventListeners;
    private broadcast;
}
export default BetterDeepSeekBridgeService;
//# sourceMappingURL=index.d.ts.map