/**
 * discover-model.ts — pure decision logic for /packed find, kept separate
 * from ctx.ui.custom rendering so it's directly testable without faking a
 * terminal (same split as model.ts for the packages panel).
 */

/** Enter's dual purpose: run a new search when the query has changed
 * since the last one (or nothing has been searched yet), otherwise treat
 * it as "activate the highlighted result" -- one key, no separate search
 * button, matching how a filter box and an action list coexist elsewhere
 * in this panel. */
export function shouldSearch(query: string, lastSearchedQuery: string | undefined, hasResults: boolean): boolean {
	if (!hasResults) return query.trim().length > 0;
	return query !== lastSearchedQuery;
}
