import fromEntries from "fromentries";
import * as twgl from "twgl.js";
import { bisector, quantileSorted } from "d3-array";
import { zoomLinear } from "vega-util";
import { PointVertexBuilder } from "../gl/dataToVertices";
import VERTEX_SHADER from "../gl/point.vertex.glsl";
import FRAGMENT_SHADER from "../gl/point.fragment.glsl";

import Mark from "./mark";
import ReservoirSampler from "../utils/reservoirSampler";

const defaultMarkProperties = {
    clip: true,

    xOffset: 0,
    yOffset: 0,

    /** TODO: Implement */
    relativeSizing: false,

    maxRelativePointDiameter: 0.8,
    minAbsolutePointDiameter: 0,

    semanticZoomFraction: 0.02
};

/** @type {Record<string, import("../view/viewUtils").EncodingConfig>} */
const defaultEncoding = {
    x: { value: 0.5 },
    y: { value: 0.5 },
    color: { value: "#4c78a8" }, // TODO: Configurable/theme
    opacity: { value: 1.0 },
    size: { value: 100.0 },
    semanticScore: { value: 0.0 }, // TODO: Should be datum instead of value. But needs fixing.
    shape: { value: "circle" },
    strokeWidth: { value: 0.0 },
    gradientStrength: { value: 0.0 }
};

export const SHAPES = fromEntries(
    [
        "circle",
        "square",
        "triangle-up",
        "cross",
        "diamond",
        "triangle-down",
        "triangle-right",
        "triangle-left"
    ].map((shape, i) => [shape, i])
);

export default class PointMark extends Mark {
    /**
     * @param {import("../view/unitView").default} unitView
     */
    constructor(unitView) {
        super(unitView);

        /** @type {Record<string, any>} */
        this.properties = {
            ...defaultMarkProperties,
            ...this.properties
        };
    }

    getRawAttributes() {
        return {
            x: {},
            y: {}
        };
    }

    getDefaultEncoding() {
        return { ...super.getDefaultEncoding(), ...defaultEncoding };
    }

    initializeData() {
        super.initializeData();

        const xAccessor = this.unitView.getAccessor("x");
        if (xAccessor) {
            // Sort each point of each sample for binary search
            // TODO: Support pre-sorted data
            for (const arr of this.dataBySample.values()) {
                arr.sort((a, b) => xAccessor(a) - xAccessor(b));
            }
        }

        // Semantic zooming is currently solely a feature of point mark.
        // Build a sorted sample that allows for computing p-quantiles
        const semanticScoreAccessor = this.unitView.getAccessor(
            "semanticScore"
        );
        if (semanticScoreAccessor) {
            const sampler = new ReservoirSampler(3000); // n chosen using Stetson-Harrison
            for (const d of this.unitView.getData().flatData()) {
                // TODO: Throw on missing scores
                sampler.ingest(semanticScoreAccessor(d));
            }
            this.sampledSemanticScores = Float32Array.from(sampler.getSample());
            this.sampledSemanticScores.sort((a, b) => a - b);
        }
    }

    async initializeGraphics() {
        await super.initializeGraphics();
        this.createShaders(VERTEX_SHADER, FRAGMENT_SHADER);
    }

    updateGraphicsData() {
        this.deleteGraphicsData();

        const vertexCount =
            this.dataBySample.size === 1
                ? [...this.dataBySample.values()][0].length
                : undefined; // TODO: Sum all samples

        const builder = new PointVertexBuilder(this.encoders, vertexCount);

        for (const [sample, points] of this.dataBySample.entries()) {
            builder.addBatch(sample, points);
        }
        const vertexData = builder.toArrays();

        this.rangeMap = vertexData.rangeMap;
        this.bufferInfo = twgl.createBufferInfoFromArrays(
            this.gl,
            vertexData.arrays,
            { numElements: vertexData.vertexCount }
        );
    }

    _getGeometricScaleFactor() {
        const zoomLevel = Math.pow(2, this.properties.geometricZoomBound || 0);

        return Math.pow(
            Math.min(1, this.unitView.getZoomLevel() / zoomLevel),
            1 / 3
            // note: 1/3 appears to yield perceptually more uniform result than 1/2. I don't know why!
        );
    }

    /**
     * Returns the maximum size of the points in the data, before any scaling
     */
    _getMaxPointSize() {
        const e = this.encoders.size;
        if (e.constant) {
            return e(null);
        } else {
            return e.scale.range().reduce((a, b) => Math.max(a, b));
        }
    }

    getSemanticThreshold() {
        if (this.sampledSemanticScores) {
            const p = Math.max(
                0,
                1 -
                    this.properties.semanticZoomFraction *
                        this.getContext().genomeSpy.getExpZoomLevel()
            );
            if (p <= 0) {
                // The sampled scores may be missing the min/max values
                return -Infinity;
            } else if (p >= 1) {
                return Infinity;
            } else {
                return quantileSorted(this.sampledSemanticScores, p);
            }
        } else {
            return -1;
        }
    }

    /**
     * @param {object[]} samples
     */
    render(samples) {
        super.render(samples);

        const gl = this.gl;

        gl.enable(gl.BLEND);

        twgl.setUniforms(this.programInfo, {
            uXOffset: this.properties.xOffset,
            uYOffset: this.properties.yOffset,
            uMaxRelativePointDiameter: this.properties.maxRelativePointDiameter,
            uMinAbsolutePointDiameter: this.properties.minAbsolutePointDiameter,
            uMaxPointSize: this._getMaxPointSize(),
            uScaleFactor: this._getGeometricScaleFactor(),
            uSemanticThreshold: this.getSemanticThreshold()
        });

        twgl.setBuffersAndAttributes(gl, this.programInfo, this.bufferInfo);

        /** @type {function(any[]):number[]} */
        let findIndices;

        const xEncoder = this.encoders.x;
        if (!xEncoder.constant) {
            // Only render the points that are located within the viewport
            const bisect = bisector(xEncoder.accessor).left;
            const visibleDomain = this.unitView
                .getResolution("x")
                .getScale()
                .domain();

            // A hack to include points that are just beyond the borders. TODO: Compute based on maxPointSize
            const paddedDomain = zoomLinear(visibleDomain, null, 1.01);

            findIndices = data => [
                bisect(data, paddedDomain[0]),
                bisect(data, paddedDomain[paddedDomain.length - 1])
            ];
        }

        for (const sampleData of samples) {
            const range = this.rangeMap.get(sampleData.sampleId);
            if (range) {
                const [lower, upper] = findIndices
                    ? findIndices(this.dataBySample.get(sampleData.sampleId))
                    : [0, range.count];

                const length = upper - lower;

                if (length) {
                    twgl.setUniforms(this.programInfo, sampleData.uniforms);
                    twgl.drawBufferInfo(
                        gl,
                        this.bufferInfo,
                        gl.POINTS,
                        length,
                        range.offset + lower
                    );
                }
            }
        }
    }

    /**
     * @param {string} sampleId
     * @param {number} x position on the viewport
     * @param {number} y position on the viewport
     * @param {import("../utils/interval").default} yBand the matched band on the band scale
     */
    findDatum(sampleId, x, y, yBand) {
        const data = this.dataBySample.get(sampleId || "default");
        if (!data) {
            return null;
        }

        const e = /** @type {Object.<string, import("../encoder/encoder").NumberEncoder>} */ (this
            .encoders);

        x -= this.properties.xOffset;
        y += this.properties.yOffset;

        // TODO: This unmaintainable mess should really be replaced with picking
        const maxPointDiameter = Math.sqrt(this._getMaxPointSize());
        const factor =
            Math.max(
                this.properties.minAbsolutePointDiameter,
                Math.min(
                    yBand.width() * this.properties.maxRelativePointDiameter,
                    maxPointDiameter
                )
            ) / maxPointDiameter;

        const sizeScaleFactor = this._getGeometricScaleFactor() * factor;

        const distance = (x1, x2, y1, y2) =>
            Math.sqrt(Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2));

        const xScale = this.getContext().genomeSpy.rescaledX;

        const bisect = bisector(e.x).left;
        // Use binary search to find the range that may contain the point
        const begin = bisect(
            data,
            xScale.invert(x - (maxPointDiameter / 2) * sizeScaleFactor)
        );
        const end = bisect(
            data,
            xScale.invert(x + (maxPointDiameter / 2) * sizeScaleFactor)
        );

        const semanticThreshold = this.getSemanticThreshold();

        let lastMatch = null;
        for (let i = begin; i < end; i++) {
            const d = data[i];
            if (e.semanticScore(d) > semanticThreshold) {
                // TODO: Optimize by computing mouse y on the band scale
                const dist = distance(
                    x,
                    xScale(e.x(d)),
                    y,
                    yBand.interpolate(1 - e.y(d))
                );
                if (dist < (sizeScaleFactor * Math.sqrt(e.size(d))) / 2) {
                    lastMatch = d;
                }
            }
            // TODO: If exact match wasn't found, return the closest match within a radius of a couple of pixels
        }

        return lastMatch;
    }
}

/**
 * @param {number} edge0
 * @param {number} edge1
 * @param {number} x
 */
function smoothstep(edge0, edge1, x) {
    x = (x - edge0) / (edge1 - edge0);
    x = Math.max(0, Math.min(1, x));
    return x * x * (3 - 2 * x);
}

/**
 *
 * @param {number} x
 * @param {number} lowerlimit
 * @param {number} upperlimit
 */
function clamp(x, lowerlimit, upperlimit) {
    if (x < lowerlimit) x = lowerlimit;
    if (x > upperlimit) x = upperlimit;
    return x;
}
