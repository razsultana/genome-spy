import { isObject, isString } from "vega-util";
import { loader as vegaLoader } from "vega-loader";

import GenomeSpy from "./genomeSpy.js";
import GenomeSpyApp from "./genomeSpyApp.js";

export { default as Interval } from "./utils/interval.js";

export { GenomeSpy, GenomeSpyApp };

/**
 * Embeds GenomeSpy into the DOM
 *
 * @param {HTMLElement | string} el HTMLElement or a query selector
 * @param {object | string} spec a spec object or an url to a json spec
 * @param {object} [opt] options
 */
export async function embed(el, spec, opt = {}) {
    /** @type {HTMLElement} */
    let element;

    if (isString(el)) {
        element = document.querySelector(el);
        if (!element) {
            throw new Error(`No such element: ${el}`);
        }
    } else if (el instanceof HTMLElement) {
        element = el;
    } else {
        throw new Error(`Invalid element: ${el}`);
    }

    try {
        const specObject = isObject(spec) ? spec : await loadSpec(spec);

        specObject.baseUrl = specObject.baseUrl || "";

        if (opt.bare) {
            const genomeSpy = new GenomeSpy(element, specObject);
            applyOptions(genomeSpy, opt);
            await genomeSpy.launch();
            return genomeSpy;
        } else {
            const app = new GenomeSpyApp(element, specObject);
            applyOptions(app.genomeSpy, opt);
            await app.launch();
            return app.genomeSpy;
        }
    } catch (e) {
        element.innerText = e.toString();
        console.error(e);
    }
}

/**
 *
 * @param {import("./genomeSpy").default} genomeSpy
 * @param {object} opt
 */
function applyOptions(genomeSpy, opt) {
    if (opt.namedDataProvider) {
        genomeSpy.registerNamedDataProvider(opt.namedDataProvider);
    }
}

/**
 * Loads the spec from the given url and sets the baseUrl if it is not
 * defined in the spec.
 *
 * @param {string} url
 */
export async function loadSpec(url) {
    let spec;

    try {
        spec = JSON.parse(await vegaLoader().load(url));
    } catch (e) {
        throw new Error(
            `Could not load or parse configuration: ${url}, reason: ${e.message}`
        );
    }

    if (!spec.baseUrl) {
        const m = url.match(/^.*\//);
        spec.baseUrl = (m && m[0]) || "./";
    }

    return spec;
}

/**
 *
 * @param {string} url
 */
function isAbsoluteUrl(url) {
    return /^(http|https)?:\/\//.test(url);
}
