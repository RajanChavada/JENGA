"""Critical Path Method over the task DAG.

Pure functions over dicts + networkx. No DB, no I/O — unit-testable standalone.
"""

import networkx as nx


def build_graph(tasks, edges):
    """tasks: [{id, duration_days, ...}], edges: [{source, target}] -> DiGraph.

    Task fields are stored as node attributes so the graph is the whole model.
    """
    g = nx.DiGraph()
    for t in tasks:
        g.add_node(t["id"], **t)
    for e in edges:
        g.add_edge(e["source"], e["target"])
    return g


def compute(graph):
    """Forward + backward pass. Returns {tasks, critical_path, project_duration}.

    tasks are in graph insertion order (stable for the frontend); critical_path
    is in topological order.
    """
    order = list(nx.topological_sort(graph))
    dur = {n: graph.nodes[n]["duration_days"] for n in order}

    es, ef = {}, {}
    for n in order:  # forward
        es[n] = max((ef[p] for p in graph.predecessors(n)), default=0)
        ef[n] = es[n] + dur[n]

    project_duration = max(ef.values(), default=0)

    ls, lf = {}, {}
    for n in reversed(order):  # backward
        lf[n] = min((ls[s] for s in graph.successors(n)), default=project_duration)
        ls[n] = lf[n] - dur[n]

    depth = {
        n: i
        for i, generation in enumerate(nx.topological_generations(graph))
        for n in generation
    }

    tasks = []
    for n in graph.nodes:
        total_float = ls[n] - es[n]
        tasks.append(
            {
                **graph.nodes[n],
                "id": n,
                "depends_on": list(graph.predecessors(n)),
                "es": es[n],
                "ef": ef[n],
                "ls": ls[n],
                "lf": lf[n],
                "total_float": total_float,
                "is_critical": total_float == 0,
                "depth": depth[n],
            }
        )

    return {
        "tasks": tasks,
        "critical_path": [n for n in order if ls[n] - es[n] == 0],
        "project_duration": project_duration,
    }


def apply_delay(graph, task_id, delay_days):
    """Add delay_days to task_id's duration and recompute.

    Returns the post-delay compute() result plus:
      graph                — the delayed graph (caller persists the new duration)
      downstream_affected  — descendants whose early start actually moved
      project_slipped_days — increase in overall project duration
      float_consumed       — how much of the task's own float the delay ate
    """
    before = compute(graph)
    delayed = graph.copy()
    delayed.nodes[task_id]["duration_days"] += delay_days
    after = compute(delayed)

    es_before = {t["id"]: t["es"] for t in before["tasks"]}
    es_after = {t["id"]: t["es"] for t in after["tasks"]}
    descendants = nx.descendants(delayed, task_id)
    downstream = [
        n
        for n in nx.topological_sort(delayed)
        if n in descendants and es_after[n] != es_before[n]
    ]

    float_before = next(t for t in before["tasks"] if t["id"] == task_id)["total_float"]

    return {
        **after,
        "graph": delayed,
        "downstream_affected": downstream,
        "project_slipped_days": after["project_duration"] - before["project_duration"],
        "float_consumed": min(delay_days, float_before),
    }
