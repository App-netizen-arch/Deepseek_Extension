/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-better-deepseek`.
 * @module @deepseek-ai/dsh-better-deepseek/invariant
 */
const PACKAGE_NAME = '@deepseek-ai/dsh-better-deepseek';
/** Cordis companion plugin name. */
export const name = 'better-deepseek-invariant';
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants'];
const install = () => { };
/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
//# sourceMappingURL=invariant.js.map