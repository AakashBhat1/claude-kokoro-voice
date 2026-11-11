"""Rewrite every 1-D ConvTranspose in a Kokoro ONNX model as Unsqueeze -> 2-D ConvTranspose -> Squeeze.

Same math (height 1), but uses DirectML's well-supported 2-D path: DirectML rejects the
1-D grouped ConvTranspose with output_padding in Kokoro ("The parameter is incorrect").
Usage (GPU venv, which has `onnx`):
  .venv-gpu\\Scripts\\python.exe patch_convtranspose.py models\\kokoro-v1.0.int8.onnx models\\kokoro-v1.0.int8.dml.onnx
"""
import sys

import numpy as np
import onnx
from onnx import helper, numpy_helper


def to_2d(values: list[int], filler: int) -> list[int]:
    return [filler, *values]


def patch(model: onnx.ModelProto) -> int:
    graph = model.graph
    inits = {i.name: i for i in graph.initializer}
    axis = numpy_helper.from_array(np.array([2], dtype=np.int64), "ct2d_axis2")
    graph.initializer.append(axis)
    new_nodes, count = [], 0
    for node in graph.node:
        weight = inits.get(node.input[1]) if node.op_type == "ConvTranspose" else None
        if weight is None or len(weight.dims) != 3:
            new_nodes.append(node)
            continue
        count += 1
        attrs = {a.name: helper.get_attribute_value(a) for a in node.attribute}
        w = numpy_helper.to_array(weight)
        w4 = numpy_helper.from_array(w[:, :, None, :], f"{weight.name}_2d")
        graph.initializer.append(w4)
        x4, y4 = f"{node.name}_x2d", f"{node.name}_y2d"
        pads = attrs.get("pads", [0, 0])
        new_attrs = {
            "kernel_shape": to_2d(attrs["kernel_shape"], 1),
            "strides": to_2d(attrs.get("strides", [1]), 1),
            "dilations": to_2d(attrs.get("dilations", [1]), 1),
            "pads": [0, pads[0], 0, pads[1]],
            "group": attrs.get("group", 1),
        }
        if "output_padding" in attrs:
            new_attrs["output_padding"] = to_2d(attrs["output_padding"], 0)
        inputs = [x4, w4.name, *node.input[2:]]
        new_nodes += [
            helper.make_node("Unsqueeze", [node.input[0], axis.name], [x4], name=f"{node.name}_unsq"),
            helper.make_node("ConvTranspose", inputs, [y4], name=f"{node.name}_2d", **new_attrs),
            helper.make_node("Squeeze", [y4, axis.name], [node.output[0]], name=f"{node.name}_sq"),
        ]
    del graph.node[:]
    graph.node.extend(new_nodes)
    drop_unused_initializers(graph)
    return count


def drop_unused_initializers(graph: onnx.GraphProto) -> None:
    """Remove weights no node reads any more (the old 1-D copies)."""
    used = {name for node in graph.node for name in node.input}
    kept = [init for init in graph.initializer if init.name in used]
    del graph.initializer[:]
    graph.initializer.extend(kept)


if __name__ == "__main__":
    model = onnx.load(sys.argv[1])
    print("rewrote", patch(model), "ConvTranspose nodes")
    onnx.save(model, sys.argv[2])
