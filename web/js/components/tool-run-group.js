// Shared grouping behavior for consecutive tool nodes with the same UI shape.
(function () {
  const configs = new Map();
  const collapsedState = new Map();

  function className(config, suffix) {
    return `${config.classPrefix}-${suffix}`;
  }

  function groupStateKey(config, item) {
    const toolId = item?.dataset?.toolId || '';
    return toolId ? `${config.kind}:${toolId}` : '';
  }

  function groupMembers(root, groupId) {
    return Array.from(root.querySelectorAll('[data-tool-details-group]'))
      .filter((item) => item.dataset.toolDetailsGroup === groupId);
  }

  function setGroupClass(config, item, suffix, enabled) {
    item.classList.toggle(`tool-run-${suffix}`, enabled);
    item.classList.toggle(className(config, suffix), enabled);
  }

  function resetItem(config, item) {
    if (item.dataset.toolRunKind !== config.kind) return;
    item.querySelector(
      `:scope > .tool-header > .${className(config, 'group-count')}`,
    )?.remove();
    item.classList.remove(
      'tool-run-continuation',
      'tool-run-group-start',
      'tool-run-group-connected',
      'tool-run-group-collapsed',
      'tool-run-group-hidden',
      'tool-run-summary-normal',
      'tool-run-summary-error',
      'tool-run-summary-warning',
      className(config, 'continuation'),
      className(config, 'group-start'),
      className(config, 'group-connected'),
      className(config, 'group-collapsed'),
      className(config, 'group-hidden'),
    );
    item.parentElement?.classList.remove(
      'tool-run-row-hidden',
      className(config, 'row-hidden'),
    );
    delete item.dataset.toolDetailsGroup;
    delete item.dataset.toolRunKind;
  }

  function setCollapsed(groupId, collapsed, root = document, members = groupMembers(root, groupId)) {
    if (!groupId) return;
    if (members.length < 2) return;
    const config = configs.get(members[0].dataset.toolRunKind || '');
    if (!config) return;

    const first = members[0];
    const latest = members.at(-1);
    const stateKey = groupStateKey(config, first);
    if (stateKey) collapsedState.set(stateKey, collapsed);
    const summary = latest.classList.contains('error')
      ? 'error'
      : latest.classList.contains('warning') ? 'warning' : 'normal';
    for (const [index, member] of members.entries()) {
      setGroupClass(config, member, 'group-collapsed', collapsed && index === 0);
      setGroupClass(config, member, 'group-hidden', collapsed && index > 0);
      for (const status of ['normal', 'error', 'warning']) {
        member.classList.toggle(`tool-run-summary-${status}`,
          collapsed && index === 0 && summary === status);
      }
    }

    const rows = new Set(members.map((item) => item.parentElement).filter(Boolean));
    updateRows(config, rows);
  }

  function updateRows(config, rows) {
    for (const row of rows) {
      const children = Array.from(row.children);
      row.classList.toggle(
        'tool-run-row-hidden',
        children.length > 0
          && children.every((item) =>
            item.classList.contains('tool-run-group-hidden')),
      );
      row.classList.toggle(
        className(config, 'row-hidden'),
        children.length > 0
          && children.every((item) =>
            item.classList.contains(className(config, 'group-hidden'))),
      );
    }
  }

  function markConfig(container, config) {
    let assistantRows = [];
    let sequence = 0;
    const priorCollapsed = new Map();
    for (const start of container.querySelectorAll(
      `.${className(config, 'group-start')}`,
    )) {
      const stateKey = groupStateKey(config, start);
      if (stateKey) {
        priorCollapsed.set(
          stateKey,
          start.classList.contains(className(config, 'group-collapsed')),
        );
      }
    }

    const flushRows = () => {
      if (!assistantRows.length) return;
      const items = assistantRows.flatMap((row) => Array.from(row.children));

      for (let start = 0; start < items.length;) {
        const isEligible = (item) => item.classList.contains(config.itemClass);
        if (!isEligible(items[start])) {
          resetItem(config, items[start]);
          start++;
          continue;
        }
        let end = start + 1;
        while (end < items.length && isEligible(items[end])) {
          end++;
        }
        if (end - start > 1) {
          const members = items.slice(start, end);
          const first = members[0];
          const groupId = `${config.kind}-${sequence++}`;
          const stateKey = groupStateKey(config, first);
          const savedState = stateKey && collapsedState.has(stateKey)
            ? collapsedState.get(stateKey)
            : priorCollapsed.get(stateKey);
          const collapsed = savedState !== undefined
            ? savedState
            : members.every((item) =>
              item.classList.contains('tool-details-collapsed'));

          for (const [index, member] of members.entries()) {
            const previousConfig = configs.get(member.dataset.toolRunKind);
            if (previousConfig && previousConfig.kind !== config.kind) {
              resetItem(previousConfig, member);
            }
            setGroupClass(config, member, 'group-start', index === 0);
            setGroupClass(config, member, 'continuation', index > 0);
            setGroupClass(config, member, 'group-connected', end < items.length);
            if (member.dataset.toolDetailsGroup !== groupId) {
              member.dataset.toolDetailsGroup = groupId;
            }
            if (member.dataset.toolRunKind !== config.kind) {
              member.dataset.toolRunKind = config.kind;
            }
            if (index > 0) {
              member.querySelector(':scope > .tool-header > .tool-run-group-count')?.remove();
            }
            window.setToolDetailsCollapsed?.(member, collapsed);
          }

          let count = first.querySelector(':scope > .tool-header > .tool-run-group-count');
          if (!count) {
            count = document.createElement('span');
            count.className = `tool-run-group-count ${className(config, 'group-count')}`;
            first.querySelector(':scope > .tool-header > .tool-name')?.after(count);
          }
          if (count.textContent !== `×${members.length}`) {
            count.textContent = `×${members.length}`;
          }
          setCollapsed(groupId, collapsed, container, members);
        } else {
          resetItem(config, items[start]);
        }
        start = end;
      }
      updateRows(config, assistantRows);
      assistantRows = [];
    };

    for (const row of container.children) {
      if (row.classList?.contains('assistant-turn')) assistantRows.push(row);
      else flushRows();
    }
    flushRows();
  }

  window.registerToolRunGroup = function (config) {
    if (!config?.kind || !config.itemClass || !config.classPrefix) return false;
    configs.set(config.kind, { ...config });
    return true;
  };

  window.markToolRunGroups = function (container) {
    if (!container) return;
    for (const config of configs.values()) markConfig(container, config);
  };

  window.setToolRunGroupCollapsed = setCollapsed;

  window.resetToolRunGroupState = function () {
    collapsedState.clear();
  };
})();
