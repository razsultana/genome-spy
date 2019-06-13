import * as twgl from 'twgl-base.js';
import { scaleLinear } from 'd3-scale';
import VERTEX_SHADER from '../gl/rect.vertex.glsl';
import FRAGMENT_SHADER from '../gl/rect.fragment.glsl';
import { RectVertexBuilder } from '../gl/segmentsToVertices';

import Mark from './mark';

const defaultRenderConfig = {
    minRectWidth: 1.0,
    minRectOpacity: 0.0
};

const defaultEncoding = {
    x:       { value: 0 },
    x2:      { value: 0 },
    y:       { value: 0 },
    y2:      { value: 1.0 }, // full-height bars
    color:   { value: "#1f77b4" },
    opacity: { value: 1.0 },
};

const tesselationConfig = {
    zoomThreshold: 10,
    tiles: 35
};

export default class RectMark extends Mark {
    /**
     * @param {import("./viewUnit").UnitContext} unitContext
     * @param {import("./viewUnit").default} viewUnit
     */
    constructor(unitContext, viewUnit) {
        super(unitContext, viewUnit)

        // Needs blending or not. TODO: Make handling of defaults more systematic
        const opacity = viewUnit.getEncoding().opacity;
        this.opaque = !opacity || opacity.value >= 1.0;
    }

    getDefaultEncoding() {
        return defaultEncoding;
    }

    async initialize() {
        await super.initialize();

        this.yDomain = this._getYDomain();
    }

    onBeforeSampleAnimation() {
        const interval = this.unitContext.genomeSpy.getViewportDomain();

        if (interval.width() < this.unitContext.genomeSpy.genome.chromMapper.extent().width() / tesselationConfig.zoomThreshold) {
            // TODO: Only bufferize the samples that are being animated
            this._sampleBufferInfo = this._createSampleBufferInfo(interval,
                interval.width() / tesselationConfig.tiles);
        }            

    }

    onAfterSampleAnimation() {
        this._sampleBufferInfo = this._fullSampleBufferInfo;
    }

    /**
     * 
     * @param {import("../utils/interval").default} [interval]
     * @param {number} [tesselationThreshold]
     */
    _createSampleBufferInfo(interval, tesselationThreshold) {
        const builder = new RectVertexBuilder(
           Mark.getConstantValues(this.getEncoding()),
           Mark.getVariableChannels(this.getEncoding()),
           tesselationThreshold);

        for (const [sample, rects] of this.specsBySample.entries()) {
            builder.addBatch(sample, interval ? clipRects(rects, interval) : rects);
        }
        const vertexData = builder.toArrays();

        return {
            rangeMap: vertexData.rangeMap,
            bufferInfo: twgl.createBufferInfoFromArrays(this.gl, vertexData.arrays)
        };
    }

    _initGL() {
        const gl = this.gl;

        this.programInfo = twgl.createProgramInfo(gl, [ VERTEX_SHADER, FRAGMENT_SHADER ]);

        this._fullSampleBufferInfo = this._createSampleBufferInfo(null,
            this.unitContext.genomeSpy.genome.chromMapper.extent().width() / tesselationConfig.zoomThreshold / tesselationConfig.tiles);
        this._sampleBufferInfo = this._fullSampleBufferInfo;

        this.renderConfig = Object.assign({}, defaultRenderConfig, this.viewUnit.getRenderConfig());
    }

    /**
     * @param {object[]} samples 
     * @param {object} globalUniforms 
     */
    render(samples, globalUniforms) {
        const gl = this.gl;

        if (this.opaque) {
            gl.disable(gl.BLEND);
        } else {
            gl.enable(gl.BLEND);
        }

        gl.useProgram(this.programInfo.program);
        twgl.setUniforms(this.programInfo, {
            ...globalUniforms,
            uYDomainBegin: this.yDomain[0],
            uYDomainWidth: this.yDomain[1] - this.yDomain[0],
            uMinWidth: (this.renderConfig.minRectWidth || 1.0) / this.unitContext.track.gl.drawingBufferWidth * window.devicePixelRatio, // How many pixels
            uMinHeight : (this.renderConfig.minRectHeight || 0.0) / this.unitContext.track.gl.drawingBufferHeight * window.devicePixelRatio, // How many pixels
            uMinOpacity: this.renderConfig.minRectOpacity || 0.0
        });

        twgl.setBuffersAndAttributes(gl, this.programInfo, this._sampleBufferInfo.bufferInfo);

        for (const sampleData of samples) {
            const range = this._sampleBufferInfo.rangeMap.get(sampleData.sampleId);
            if (range) {
                twgl.setUniforms(this.programInfo, sampleData.uniforms);
                // TODO: draw only the part that intersects with the viewport
                twgl.drawBufferInfo(gl, this._sampleBufferInfo, gl.TRIANGLE_STRIP, range.count, range.offset);
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
        const rects = this.specsBySample.get(sampleId || "default");

        const scaledX = this.unitContext.genomeSpy.rescaledX.invert(x);

        const yScale = scaleLinear()
            .domain(this._getYDomain())
            .range([0, 1]);

        const scaledY = yScale.invert(1 - (y - yBand.lower) / yBand.width());

        // TODO: Support overlapping rects
        // TODO: Take minWidth into account

        const rect = rects.find(rect =>
             scaledX >= rect.x && scaledX < rect.x2 &&
             scaledY >= rect.y && scaledY < rect.y2);

        return rect;
    }


    /**
     * Finds a datum that overlaps the given value on domain.
     * The result is unspecified if multiple datums are found.
     * 
     * TODO: Rename the other findDatum to findSpec
     * 
     * @param {string} sampleId
     * @param {number} x position on the x domain
     */
    findDatumAt(sampleId, x) {
        const rects = this.specsBySample.get(sampleId);
        const rect = rects.find(rect => x >= rect.x && x < rect.x2);
        return rect && rect.rawDatum || undefined;
    }


    getRangeAggregates() {
        // Aggregates can be used for sorting and filtering

        // TODO: Implement
        // Stuff that computes aggregates for a field of a (ordered) set of datums
        // Quantitative: Max, min, (weighted) mean, count, (total) difference between adjacent columns
        // Categorical: The most common category, other?
        return {
            quantitative: null,
            categorical: null
        };
    }

}

/**
 * 
 * @param {import("../gl/segmentsToVertices").RectSpec[]} rects 
 * @param {import("../utils/interval").default} interval
 */
function clipRects(rects, interval) {
    const lower = interval.lower, upper = interval.upper;
    const clipped = [];

    for (const rect of rects) {
        if (rect.x2 < lower || rect.x > upper) {
            // TODO: Use binary search for culling
            continue;

        } else if (rect.x >= lower && rect.x2 <= upper) {
            clipped.push(rect);

        } else {
            clipped.push(Object.assign(Object.create(rect),
                {
                    x: Math.max(rect.x, lower),
                    x2: Math.min(rect.x2, upper)
                }
            ));
        }
    }

    return clipped;
}
