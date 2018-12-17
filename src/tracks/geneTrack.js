import * as d3 from "d3";
import { Matrix4 } from 'math.gl';
import {
	Program, VertexArray, Buffer, assembleShaders, setParameters, createGLContext,
	resizeGLContext, fp64
} from 'luma.gl';
import WebGlTrack from './webGlTrack';
import Interval from "../utils/interval";

import geneVertexShader from '../gl/geneVertex.glsl';
import geneFragmentShader from '../gl/geneFragment.glsl';
import exonVertexShader from '../gl/exonVertex.glsl';
import rectangleFragmentShader from '../gl/rectangleFragment.glsl';
import fenceSync from "luma.gl/dist/es5/webgl/fence-sync";


// When does something become visible.
// The values are the width of the visible domain in base pairs
const overviewBreakpoint = 250 * 1000000;
const transcriptBreakpoint = 40 * 1000000; // TODO: Should depend on viewport size

const maxLanes = 7;


export class GeneTrack extends WebGlTrack {
    constructor(genes) {
		super();
		
		this.genes = genes;
		this.geneClusters = detectGeneClusters(genes);

		// TODO: Configuration object
		this.geneHeight = 11;
		this.geneSpacing = 4;

    }

    initialize({genomeSpy, trackContainer}) {
        super.initialize({genomeSpy, trackContainer});

        this.trackContainer.className = "gene-track";
		this.trackContainer.style.height = "60px";
		this.trackContainer.style.marginTop = "10px";

		this.glCanvas = this.createCanvas();

        const gl = createGLContext({ canvas: this.glCanvas });
        this.gl = gl;

        setParameters(gl, {
            clearColor: [1, 1, 1, 1],
            clearDepth: [1],
            depthTest: false,
            depthFunc: gl.LEQUAL
		});

        this.geneProgram = new Program(gl, assembleShaders(gl, {
            vs: geneVertexShader,
            fs: geneFragmentShader,
            modules: ['fp64']
		}));

        this.exonProgram = new Program(gl, assembleShaders(gl, {
            vs: exonVertexShader,
            fs: rectangleFragmentShader,
            modules: ['fp64']
		}));

        this.clusterProgram = new Program(gl, assembleShaders(gl, {
            vs: exonVertexShader,
            fs: rectangleFragmentShader,
            modules: ['fp64']
		}));

		this.visibleGenes = [];

		this.visibleClusters = [];
		
		this.geneVerticeMap = new Map();
		this.exonVerticeMap = new Map();

		// exonsToVertices only cares about intervals
		//this.clusterVertices = exonsToVertices(this.clusterProgram, this.geneClusters);

        genomeSpy.on("zoom", () => {
			this.render();
		});

        genomeSpy.on("layout", layout => {
            this.resizeCanvases(layout);
            this.render();
        });

        const cm = genomeSpy.chromMapper;
        this.chromosomes = cm.chromosomes();
    }

    resizeCanvases(layout) {
		this.adjustCanvas(this.glCanvas, layout.viewport);

        resizeGLContext(this.gl, { useDevicePixels: false });
		this.gl.viewport(0, 0, this.gl.drawingBufferWidth, this.gl.drawingBufferHeight);


		// TODO: Maybe could be provided by some sort of abstraction
        this.projection = Object.freeze(new Matrix4().ortho({
            left: 0,
            right: this.gl.drawingBufferWidth,
            bottom: this.gl.drawingBufferHeight,
            top: 0,
            near: 0,
            far: 500
		}));
		
		
		// Precompute matrices for different lanes
		// Ugh, gimme a range generator!
		this.laneMatrices = [];

		for (var i = 0; i < maxLanes; i++) {
			const view = new Matrix4()
				.translate([0, i * (this.geneHeight + this.geneSpacing), 0])
				.scale([this.gl.drawingBufferWidth, this.geneHeight, 1]);

			this.laneMatrices.push(this.projection.clone().multiplyRight(view));
		}
	}
	
	updateVisibleClusters() {
		const vi = this.getViewportDomain();
		
		const clusters = this.geneClusters.slice(
			d3.bisector(d => d.interval.upper).right(this.geneClusters, vi.lower),
			d3.bisector(d => d.interval.lower).left(this.geneClusters, vi.upper)
		);

		const oldIds = new Set(this.visibleClusters.map(g => g.id));
		const newIds = new Set(clusters.map(g => g.id));

		const entering = clusters.filter(g => !oldIds.has(g.id));
		const exiting =  this.visibleClusters.filter(g => !newIds.has(g.id));
		
		this.visibleClusters = clusters;


		entering.forEach(cluster => {
			this.exonVerticeMap.set(
				cluster.id,
				exonsToVertices(
					this.exonProgram,
					cluster.genes,
					this.geneHeight,
					this.geneSpacing
				));

			this.geneVerticeMap.set(
				cluster.id,
				genesToVertices(
					this.geneProgram,
					cluster.genes,
					this.geneHeight,
					this.geneSpacing
				));
		});

		exiting.forEach(cluster => {
			const exonVertices = this.exonVerticeMap.get(cluster.id);
			if (exonVertices) {
				exonVertices.vertexArray.delete();
				this.exonVerticeMap.delete(cluster.id);

			} else {
				// TODO: Figure out what's the problem
				console.warn("No exon vertices found for " + cluster.id);
			}

			const geneVertices = this.geneVerticeMap.get(cluster.id);
			if (geneVertices) {
				geneVertices.vertexArray.delete();
				this.geneVerticeMap.delete(cluster.id);

			} else {
				// TODO: Figure out what's the problem
				console.warn("No gene vertices found for " + cluster.id);
			}
		});
	}


	render() {
		const gl = this.gl;
		gl.clear(gl.COLOR_BUFFER_BIT);

		if (this.getViewportDomain().width() < transcriptBreakpoint) {
//			this.updateVisibleGenes();
			this.updateVisibleClusters();
			this.renderGenes();

		} else {
			//this.renderClusters();
		}
	}

	renderClusters() {
        const gl = this.gl;

		// TODO: Precalc
		const uniforms = Object.assign(
			this.getDomainUniforms(),
			{
				minWidth: 0.5 / gl.drawingBufferWidth, // How many pixels
				ONE: 1.0 // WTF: https://github.com/uber/luma.gl/pull/622
			}
		);

		// TODO: Precalc
		const view = new Matrix4()
//			.translate([0, i * (geneHeight + geneSpacing), 0])
			.scale([this.gl.drawingBufferWidth, this.geneHeight, 1]);

		// TODO: Precalc
		const uTMatrix = this.projection.clone().multiplyRight(view);

		this.clusterProgram.draw(Object.assign(
			{
				uniforms: Object.assign(
					uniforms,
					{ uTMatrix }
				)
			},
			this.clusterVertices
		));
	}

	renderGenes() {
        const gl = this.gl;

		const uniforms = Object.assign(
			this.getDomainUniforms(),
			{
				minWidth: 0.5 / gl.drawingBufferWidth, // How many pixels
				ONE: 1.0 // WTF: https://github.com/uber/luma.gl/pull/622
			}
		);

		const view = new Matrix4()
			.scale([this.gl.drawingBufferWidth, 1, 1]);
		const uTMatrix = this.projection.clone().multiplyRight(view);

        this.visibleClusters.forEach(cluster => {
			this.exonProgram.draw(Object.assign(
				{
					uniforms: Object.assign(
						uniforms,
						{ uTMatrix: uTMatrix }
					)
				},
				this.exonVerticeMap.get(cluster.id)
			));

			gl.enable(gl.BLEND);
			gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
			gl.disable(gl.DEPTH_TEST);

			this.geneProgram.draw(Object.assign(
				{
					uniforms: Object.assign(
						uniforms,
						{ uTMatrix: uTMatrix, uResolution: this.geneHeight }
					)
				},
				this.geneVerticeMap.get(cluster.id)
			));

			gl.disable(gl.BLEND);
        });

	}


	search(string) {
		string = string.toUpperCase();

		// TODO: Use array.find (not supported in older browsers)
		const results = this.genes.filter(d => d.symbol == string);
		if (results.length > 0) {
			// Find the longest matching transcript
			results.sort((a, b) => b.interval.width() - a.interval.width());
			const interval = results[0].interval;

			// Add some padding around the gene
			const padding = interval.width() * 0.25;
			return new Interval(interval.lower - padding, interval.upper + padding);

		} else {
			return null;
		}
	}
}



function createExonIntervals(gene) {

	// These should be benchmarked...

	/*
	const geneStart = gene.interval.lower;

	const cumulativeExons = gene.exons.split(",")
		.map(x => parseInt(x, 10))
		.reduce(function (r, c, i) { r.push((r[i - 1] || 0) + c); return r }, []);

	const exons = [];

	// TODO: Use Javascript generators
	for (var i = 0; i < cumulativeExons.length / 2; i++) {
		exons.push(new Interval(
			geneStart + cumulativeExons[i * 2],
			geneStart + cumulativeExons[i * 2 + 1])
		);
	}
	*/

	// TODO: Check that gene length equals to cumulative length

	const exons = [];
	const steps = gene.exons.split(",");

	let cumulativePos = gene.interval.lower;

	for (let i = 0; i < steps.length;) {
		cumulativePos += parseInt(steps[i++], 10);
		const lower = cumulativePos;
		cumulativePos += parseInt(steps[i++], 10);
		const upper = cumulativePos;

		exons.push(new Interval(lower, upper));
	}

	return exons;
}

function exonsToVertices(program, genes, laneHeight, laneSpacing) {
	const VERTICES_PER_RECTANGLE = 6;
	
	const exonsOfGenes = genes.map(g => createExonIntervals(g));

	const totalExonCount = exonsOfGenes
		.map(exons => exons.length)
		.reduce((a, b) => a + b, 0);

    const x = new Float32Array(totalExonCount * VERTICES_PER_RECTANGLE * 2);
    const y = new Float32Array(totalExonCount * VERTICES_PER_RECTANGLE);
    const widths = new Float32Array(totalExonCount * VERTICES_PER_RECTANGLE);

	let i = 0;

	genes.forEach((gene, gi) => {
		exonsOfGenes[gi].forEach(exon => {
			const begin = fp64.fp64ify(exon.lower);
			const end = fp64.fp64ify(exon.upper);
			const width = exon.width();

			const top = gene.lane * (laneHeight + laneSpacing);
			const bottom = top + laneHeight;

			x.set([].concat(begin, end, begin, end, begin, end), i * VERTICES_PER_RECTANGLE * 2);
			y.set([bottom, bottom, top, top, top, bottom], i * VERTICES_PER_RECTANGLE);
			widths.set([-width, width, -width, width, -width, width], i * VERTICES_PER_RECTANGLE);

			i++;
		});
	});

    const gl = program.gl;
    const vertexArray = new VertexArray(gl, { program });

    vertexArray.setAttributes({
        x: new Buffer(gl, { data: x, size: 2, usage: gl.STATIC_DRAW }),
        y: new Buffer(gl, { data: y, size: 1, usage: gl.STATIC_DRAW }),
        width: new Buffer(gl, { data: widths, size: 1, usage: gl.STATIC_DRAW }),
    });

    return {
        vertexArray: vertexArray,
        vertexCount: totalExonCount * VERTICES_PER_RECTANGLE
    };
}


function genesToVertices(program, genes, laneHeight, laneSpacing) {
    const VERTICES_PER_RECTANGLE = 6;
    const x = new Float32Array(genes.length * VERTICES_PER_RECTANGLE * 2);
	const y = new Float32Array(genes.length * VERTICES_PER_RECTANGLE);
	const yEdge = new Float32Array(genes.length * VERTICES_PER_RECTANGLE);

    genes.forEach((gene, i) => {
        const begin = fp64.fp64ify(gene.interval.lower);
        const end = fp64.fp64ify(gene.interval.upper);

		const top = gene.lane * (laneHeight + laneSpacing);
		const bottom = top + laneHeight;

		const topEdge = 0.0;
		const bottomEdge = 1.0;

        x.set([].concat(begin, end, begin, end, begin, end), i * VERTICES_PER_RECTANGLE * 2);
		y.set([bottom, bottom, top, top, top, bottom], i * VERTICES_PER_RECTANGLE);
        yEdge.set([bottomEdge, bottomEdge, topEdge, topEdge, topEdge, bottomEdge], i * VERTICES_PER_RECTANGLE);
    });

    const gl = program.gl;
    const vertexArray = new VertexArray(gl, { program });

    vertexArray.setAttributes({
        x: new Buffer(gl, { data: x, size : 2, usage: gl.STATIC_DRAW }),
        y: new Buffer(gl, { data: y, size : 1, usage: gl.STATIC_DRAW }),
        yEdge: new Buffer(gl, { data: yEdge, size : 1, usage: gl.STATIC_DRAW }),
    });

    return {
        vertexArray: vertexArray,
        vertexCount: genes.length * VERTICES_PER_RECTANGLE
    };
}


export function parseCompressedRefseqGeneTsv(cm, geneTsv) {
    const chromNames = new Set(cm.chromosomes().map(chrom => chrom.name));

    const genes = d3.tsvParseRows(geneTsv)
        .filter(row => chromNames.has(row[2]))
        .map(row => {

            const start = parseInt(row[3], 10);
            const end = start + parseInt(row[4], 10);

            return {
                id: row[0],
                symbol: row[1],
                chrom: row[2],
                start: start,
                end: end,
                strand: row[5],
                exons: row[6],
                // Precalc for optimization
                interval: cm.segmentToContinuous(row[2], start, end)
            };
        });

	genes.sort((a, b) => a.interval.lower - b.interval.lower);

	const lanes = [];

	genes.forEach(g => {
		let laneNumber = lanes.findIndex(end => end < g.interval.lower);
		if (laneNumber < 0) {
			laneNumber = lanes.push(0) - 1;
		}
		lanes[laneNumber] = g.interval.upper;
		g.lane = laneNumber;
	});

	return genes;
}


function detectGeneClusters(genes) {
	// For overview purposes we create a union of overlapping transcripts
	// and merge adjacent segments that are close enough to each other

	const mergeDistance = 75000;

	let concurrentCount = 0;
	let union = [];
	let leftEdge = null;
	let previousEnd = 0;
	let index = 0;

	let genesInBlock = [];

	genes.map(g => ({pos: g.interval.lower, start: true, gene: g}))
		.concat(genes.map(g => ({pos: g.interval.upper, start: false, gene: g})))
		.sort((a, b) => a.pos - b.pos)
		.forEach(edge => {
			if (edge.start) {
				if (concurrentCount == 0) {
					if (leftEdge == null) {
						leftEdge = edge.pos;
					}

					if (edge.pos - previousEnd > mergeDistance) {
						union.push({
							id: index,
							genes: genesInBlock,
							interval: new Interval(leftEdge, previousEnd)
						});

						genesInBlock = [];
						leftEdge = edge.pos;
						index++;
					}

				}
				genesInBlock.push(edge.gene);
				concurrentCount++;
			}

			if (!edge.start) {
				concurrentCount--;
				previousEnd = edge.pos;
			}

		});

	if (leftEdge) {
		union.push({
			id: index,
			genes: genesInBlock,
			interval: new Interval(leftEdge, previousEnd)
		});
	}

	//console.log(union);

	return union;
}
