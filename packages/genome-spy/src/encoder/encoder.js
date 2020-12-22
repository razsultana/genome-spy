import { isNumber } from "vega-util";
import { isDiscrete } from "vega-scale";
import createIndexer from "../utils/indexer";

/**
 * @typedef {Object} EncoderMetadata
 * @prop {boolean} constant True if the accessor returns the same value for all objects
 * @prop {boolean} constantValue True the encoder returns a "value" without a scale
 * @prop {function} invert
 * @prop {VegaScale} [scale]
 * @prop {import("./accessor").Accessor} accessor
 * @prop {import("../view/viewUtils").EncodingConfig} encodingConfig
 * @prop {function(function):void} applyMetadata Copies metadata to the target function
 *
 * @typedef {(function(object):(string|number)) & EncoderMetadata} Encoder
 * @typedef {(function(object):number) & EncoderMetadata} NumberEncoder
 *
 * @typedef {object} ScaleMetadata
 * @prop {string} type Scale type
 * @prop {boolean} fp64 Whether to use emulated 64 bit floating point in WebGL
 * 
 * @typedef {(
    import("d3-scale").ScaleContinuousNumeric<any, any> |
    import("d3-scale").ScaleLinear<any, any> |
    import("d3-scale").ScalePower<any, any> |
    import("d3-scale").ScaleLogarithmic<any, any> |
    import("d3-scale").ScaleSymLog<any, any> |
    import("d3-scale").ScaleIdentity |
    import("d3-scale").ScaleTime<any, any> |
    import("d3-scale").ScaleSequential<any> |
    import("d3-scale").ScaleDiverging<any> | 
    import("d3-scale").ScaleQuantize<any> |
    import("d3-scale").ScaleQuantile<any> |
    import("d3-scale").ScaleThreshold<any, any> |
    import("d3-scale").ScaleOrdinal<any, any> |
    import("d3-scale").ScaleBand<any> |
    import("d3-scale").ScalePoint<any>
    )} D3Scale
 * 
 * @typedef {D3Scale & ScaleMetadata} VegaScale
 */

/**
 * Creates an object that contains encoders for every channel of a mark
 *
 * TODO: This should actually receive the mark as parameter
 *
 * TODO: This method should have a test. But how to mock Mark...
 *
 * @param {import("../marks/mark").default} mark
 * @param {Record<string, import("../view/viewUtils").EncodingConfig>} [encodingConfigs] Taken from the mark if not provided
 * @returns {Record<string, Encoder>}
 */
export default function createEncoders(mark, encodingConfigs) {
    /** @type {Record<string, Encoder>} */
    const encoders = {};

    if (!encodingConfigs) {
        encodingConfigs = mark.encoding;
    }

    for (const [channel, encodingConfig] of Object.entries(encodingConfigs)) {
        if (!encodingConfig) {
            continue;
        }

        const resolution = mark.unitView.getScaleResolution(
            primaryChannel(channel)
        );
        const scale = (resolution && resolution.getScale()) || undefined;

        encoders[channel] = createEncoder(
            encodingConfigs[channel],
            scale,
            mark.unitView.getAccessor(channel),
            channel
        );
    }

    return encoders;
}

/**
 *
 * @param {import("../view/viewUtils").EncodingConfig} encodingConfig
 * @param {any} scale
 * @param {import("./accessor").Accessor} accessor
 * @param {string} channel
 * @returns {Encoder}
 */
export function createEncoder(encodingConfig, scale, accessor, channel) {
    /** @type {Encoder} */
    let encoder;

    if (isValueEncoding(encodingConfig)) {
        encoder = /** @type {Encoder} */ (datum => encodingConfig.value);
        encoder.constant = true;
        encoder.constantValue = true;
        encoder.accessor = undefined;
    } else if (accessor) {
        if (channel == "text") {
            // TODO: Define somewhere channels that don't use a scale
            encoder = /** @type {Encoder} */ (datum => undefined);
            encoder.accessor = accessor;
            encoder.constant = accessor.constant;
        } else {
            if (!scale) {
                throw new Error(
                    `Missing scale! "${channel}": ${JSON.stringify(
                        encodingConfig
                    )}`
                );
            }

            if (isDiscrete(scale.type)) {
                // TODO: and check that it's raw
                // TODO: pass the found values back to the scale/resolution
                const indexer = createIndexer();
                indexer.addAll(scale.domain());
                scale = indexer;
            }

            encoder = /** @type {Encoder} */ (datum => scale(accessor(datum)));

            encoder.constant = accessor.constant;
            encoder.accessor = accessor;
            encoder.scale = scale;
        }
    } else {
        throw new Error(
            `Missing value or accessor (field, expr, datum) on channel "${channel}": ${JSON.stringify(
                encodingConfig
            )}`
        );
    }

    // TODO: Modifier should be inverted too
    encoder.invert = scale
        ? value => scale.invert(value)
        : value => {
              throw new Error(
                  "No scale available, cannot invert: " +
                      JSON.stringify(encodingConfig)
              );
          };

    // Just to provide a convenient access to the config
    encoder.encodingConfig = encodingConfig;

    /** @param {Encoder} target */
    encoder.applyMetadata = target => {
        for (const prop in encoder) {
            if (prop in encoder) {
                target[prop] = encoder[prop];
            }
        }
        return target;
    };

    return encoder;
}

/**
 * TODO: Move to a more generic place
 *
 * @param {import("../view/view").EncodingConfig} encodingConfig
 */
function isValueEncoding(encodingConfig) {
    return "value" in encodingConfig;
}

/**
 * Map primary channels to secondarys
 *
 * @type {Record<string, string>}
 */
export const secondaryChannels = {
    x: "x2",
    y: "y2",
    size: "size2",
    color: "color2"
};

/**
 * Map secondary channels to primaries
 *
 * @type {Record<string, string>}
 */
export const primaryChannels = Object.fromEntries(
    Object.entries(secondaryChannels).map(entry => [entry[1], entry[0]])
);

/**
 *
 * @param {string} channel
 */
export function isSecondaryChannel(channel) {
    return channel in primaryChannels;
}

/**
 * Return the matching secondary channel or throws if one does not exist.
 *
 * @param {string} primaryChannel
 */
export function secondaryChannel(primaryChannel) {
    const secondary = secondaryChannels[primaryChannel];
    if (secondary) {
        return secondary;
    } else {
        throw new Error(`${primaryChannel} has no secondary channel!`);
    }
}

/**
 * Finds the primary channel for the provided channel, which may be
 * the primary or secondary.
 *
 * @param {string} maybeSecondary
 */
export function primaryChannel(maybeSecondary) {
    return primaryChannels[maybeSecondary] || maybeSecondary;
}

/**
 * Returns an array that contains the given channel and its secondary channel if one exists.
 *
 * @param {string} channel
 */
export function channelWithSecondarys(channel) {
    return secondaryChannels[channel]
        ? [channel, secondaryChannels[channel]]
        : [channel];
}

/**
 * @param {string} channel
 */
export function isPositionalChannel(channel) {
    return ["x", "y"].includes(primaryChannel(channel));
}
