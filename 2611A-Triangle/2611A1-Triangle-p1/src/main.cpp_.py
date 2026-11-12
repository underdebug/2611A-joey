def pickOrbitPivot():
    import os
    from mem import mem
    import matplotlib.pyplot as plt

    points = {}
    for name in ('nearPoint', 'farPoint', 'cameraPosition_'):
        value = mem(name)
        points[name] = [float(value[axis]) for axis in 'xyz']

    fig = plt.figure('pickOrbitPivot')
    ax = fig.add_subplot(111, projection='3d')
    colors = {'nearPoint': 'tab:green', 'farPoint': 'tab:red',
              'cameraPosition_': 'tab:blue'}
    for name, point in points.items():
        ax.scatter(*point, color=colors[name], label=name, s=55)
        ax.text(*point, '  ' + name)

    ax.plot(*zip(points['nearPoint'], points['farPoint']),
            color='tab:orange', label='picking ray')
    ax.set(xlabel='X', ylabel='Y', zlabel='Z', title='Picking ray (world coordinates)')
    ax.legend()

    spans = [max(p[i] for p in points.values()) - min(p[i] for p in points.values())
             for i in range(3)]
    radius = max(max(spans) / 2, 0.5)
    for i, set_limit in enumerate((ax.set_xlim, ax.set_ylim, ax.set_zlim)):
        center = (max(p[i] for p in points.values()) +
                  min(p[i] for p in points.values())) / 2
        set_limit(center - radius, center + radius)
    project_path = os.environ.get('PROJECT_PATH') or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    figure_dir = os.path.join(project_path, 'mem', 'figure')
    os.makedirs(figure_dir, exist_ok=True)
    figure_path = os.path.join(figure_dir, 'pickOrbitPivot.png')
    fig.savefig(figure_path, dpi=150, bbox_inches='tight')
    plt.close(fig)
    os.spawnlp(os.P_NOWAIT, 'xdg-open', 'xdg-open', figure_path)
