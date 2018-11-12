import * as d3 from "d3";
import { VertexArray, Buffer, fp64 } from 'luma.gl';

const black = d3.color("black");

export default function segmentsToVertices(program, segments) {
    const VERTICES_PER_RECTANGLE = 6;
    const x = new Float32Array(segments.length * VERTICES_PER_RECTANGLE * 2);
    const y = new Float32Array(segments.length * VERTICES_PER_RECTANGLE);
    const colors = new Float32Array(segments.length * VERTICES_PER_RECTANGLE * 4);

    segments.forEach((s, i) => {
        const begin = fp64.fp64ify(s.interval.lower);
        const end = fp64.fp64ify(s.interval.upper);

        const topLeft = 0.0 + (s.paddingTopLeft || s.paddingTop || 0);
        const topRight = 0.0 + (s.paddingTopRight || s.paddingTop || 0);

        const bottomLeft = 1.0 - (s.paddingBottomLeft || s.paddingBottom || 0);
        const bottomRight = 1.0 - (s.paddingBottomRight || s.paddingBottom || 0);

        const color = s.color || black;

        x.set([].concat(begin, end, begin, end, begin, end), i * VERTICES_PER_RECTANGLE * 2);
        y.set([bottomLeft, bottomRight, topLeft, topRight, topLeft, bottomRight], i * VERTICES_PER_RECTANGLE);
        const c = [color.r / 255.0, color.g / 255.0, color.b / 255.0, color.opacity];
        colors.set([].concat(c, c, c, c, c, c), i * VERTICES_PER_RECTANGLE * 4);
    });

    const gl = program.gl;
    const vertexArray = new VertexArray(gl, { program });

    vertexArray.setAttributes({
        x: new Buffer(gl, { data: x, size : 2, usage: gl.STATIC_DRAW }),
        y: new Buffer(gl, { data: y, size : 1, usage: gl.STATIC_DRAW }),
        color: new Buffer(gl, { data: colors, size: 4, usage: gl.STATIC_DRAW })
    });

    return {
        vertexArray: vertexArray,
        vertexCount: segments.length * VERTICES_PER_RECTANGLE
    };
}