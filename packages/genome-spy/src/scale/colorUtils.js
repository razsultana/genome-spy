import { color as d3color } from "d3-color";
import { range } from "d3-array";
import { scheme as vegaScheme } from "vega-scale";
import { isString, isArray, isFunction } from "vega-util";
import * as twgl from "twgl.js";
import { peek } from "../utils/arrayUtils";

/**
 * @param {string | import("../spec/scale").SchemeParams} schemeDef
 * @param {WebGL2RenderingContext} gl
 */
export function createSchemeTexture(schemeDef, gl) {
    const schemeName = isString(schemeDef) ? schemeDef : schemeDef.name;
    const extent = (!isString(schemeDef) && schemeDef.extent) || [0, 1];

    if (schemeName) {
        const scheme = vegaScheme(schemeName);
        if (isFunction(scheme)) {
            // TODO: Reverse
            const textureData = interpolatorToTextureData(scheme, { extent });
            return twgl.createTexture(gl, {
                minMag: gl.LINEAR,
                format: gl.RGB,
                src: textureData,
                height: 1,
                wrap: gl.CLAMP_TO_EDGE
            });
        } else if (isArray(scheme)) {
            return createDiscreteColorTexture(scheme, gl);
        } else {
            throw new Error("Unknown scheme: " + schemeName);
        }
    }
}

/**
 *
 * @param {string[]} colors
 * @param {WebGL2RenderingContext} gl
 */
export function createDiscreteColorTexture(colors, gl) {
    const textureData = colorArrayToTextureData(colors);
    return twgl.createTexture(gl, {
        minMag: gl.NEAREST,
        format: gl.RGB,
        src: textureData,
        height: 1
    });
}

/**
 * Renders an interpolator to a texture.
 *
 * @param {function(number):string} interpolator
 * @param {object} options
 * @param {number[]} [options.extent]
 * @param {boolean} [options.reverse]
 * @param {number} [options.size]
 */
function interpolatorToTextureData(
    interpolator,
    { extent = [0, 1], reverse = false, size = 256 } = {}
) {
    const start = extent[0];
    const span = peek(extent) - start;

    const steps = range(size)
        .map(x => x / (size - 1))
        .map(x => start + x / span)
        .map(interpolator);

    if (reverse) {
        steps.reverse();
    }

    return colorArrayToTextureData(steps);
}

/**
 * Renders a scheme (an array of colors) to a texture.
 *
 * @param {string[]} scheme
 */
function colorArrayToTextureData(scheme) {
    const size = scheme.length;

    const textureData = new Uint8Array(size * 3);
    for (let i = 0; i < size; i++) {
        const color = d3color(scheme[i]).rgb();
        textureData[i * 3 + 0] = color.r;
        textureData[i * 3 + 1] = color.g;
        textureData[i * 3 + 2] = color.b;
    }
    return textureData;
}