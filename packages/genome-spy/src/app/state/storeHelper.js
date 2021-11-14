import { combineReducers, configureStore } from "@reduxjs/toolkit";
import { batchActions, enableBatching } from "redux-batched-actions";

/**
 * Provides some convenience stuff for redux store
 *
 * @typedef {import("@reduxjs/toolkit").AnyAction} Action
 */
export default class StoreHelper {
    /**
     * @param {import("redux").ReducersMapObject} [reducers]
     */
    constructor(reducers) {
        this._reducers = reducers ?? {};

        // TODO: The actual store could be outside of Provenance so that it could
        // also include non-undoable reducers
        this.store = configureStore({
            reducer: {},
        });

        /** @type {Set<(state: any) => void>} */
        this._listeners = new Set();

        this.store.subscribe(() => {
            const state = this.store.getState();
            for (const listener of this._listeners) {
                listener(state);
            }
        });
    }

    /**
     *
     * @param {string} name
     * @param {import("redux").Reducer} reducer
     */
    addReducer(name, reducer) {
        this._reducers[name] = reducer;

        this.store.replaceReducer(
            enableBatching(combineReducers(this._reducers))
        );
    }

    /**
     * @param {(state: any) => void} listener
     */
    subscribe(listener) {
        this._listeners.add(listener);
    }

    /**
     * @param {(state: any) => void} listener
     */
    unsubscribe(listener) {
        this._listeners.delete(listener);
    }

    /**
     * @param {Action | Action[]} action
     */
    dispatch(action) {
        if (Array.isArray(action)) {
            this.store.dispatch(batchActions(action));
        } else {
            this.store.dispatch(action);
        }
    }

    getDispatcher() {
        return (/** @type {Action} */ action) => this.dispatch(action);
    }
}