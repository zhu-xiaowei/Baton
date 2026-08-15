// Claude Code's Settings panel rendered from structured headless control data.
(function () {
  var panels = Object.create(null);

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function compactNumber(value) {
    var number = Number(value) || 0;
    if (Math.abs(number) < 1000) return number.toLocaleString();
    if (Math.abs(number) < 1000000) return (number / 1000).toFixed(number < 10000 ? 1 : 0) + 'k';
    if (Math.abs(number) < 1000000000) return (number / 1000000).toFixed(number < 10000000 ? 1 : 0) + 'm';
    return (number / 1000000000).toFixed(1) + 'b';
  }

  function duration(value) {
    var milliseconds = Number(value) || 0;
    var seconds = Math.max(0, Math.round(milliseconds / 1000));
    if (seconds < 60) return seconds + 's';
    var minutes = Math.floor(seconds / 60);
    var remainder = seconds % 60;
    if (minutes < 60) return minutes + 'm' + (remainder ? ' ' + remainder + 's' : '');
    var hours = Math.floor(minutes / 60);
    minutes %= 60;
    return hours + 'h' + (minutes ? ' ' + minutes + 'm' : '');
  }

  function displayValue(value) {
    if (value == null || value === '') return '—';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }

  function rows(items, className) {
    if (!items || !items.length) return '<div class="cc-empty">No data available</div>';
    return '<dl class="' + (className || 'cc-info-rows') + '">' + items.map(function (item) {
      var value = item.value;
      if (item.format === 'duration') value = duration(value);
      else if (item.format === 'number') value = compactNumber(value);
      return '<div><dt>' + esc(item.label || item.key) + '</dt><dd title="'
        + esc(displayValue(value)) + '">' + esc(displayValue(value)) + '</dd></div>';
    }).join('') + '</dl>';
  }

  function configSection(title, items) {
    if (!items || !items.length) return '';
    return '<section class="cc-config-group"><h4>' + esc(title) + '</h4>'
      + rows(items, 'cc-info-rows cc-config-rows') + '</section>';
  }

  function statusTab(panel) {
    var diagnostics = panel.status.diagnostics || [];
    return rows(panel.status.items)
      + (diagnostics.length
        ? '<div class="cc-diagnostics">' + diagnostics.map(function (item) {
          return '<div><strong>' + esc(item.source) + '</strong> ' + esc(item.error) + '</div>';
        }).join('') + '</div>'
        : '');
  }

  function configTab(panel) {
    var html = configSection('Applied for this session', panel.config.applied)
      + configSection('Effective settings', panel.config.effective);
    for (var i = 0; i < (panel.config.sources || []).length; i++) {
      var source = panel.config.sources[i];
      html += configSection(source.source, source.entries);
    }
    if (panel.truncated) {
      html += '<div class="cc-panel-note">Some details were omitted to fit remote transport.</div>';
    }
    return html || '<div class="cc-empty">No settings reported</div>';
  }

  function usageTab(panel) {
    var html = rows(panel.usage.items);
    if (panel.usage.subscriptionType) {
      html += '<div class="cc-usage-note">Subscription: '
        + esc(panel.usage.subscriptionType) + '</div>';
    }
    if (panel.usage.rateLimitsAvailable && panel.usage.rateLimits) {
      html += configSection('Rate limits', [{
        key: 'Limits',
        value: panel.usage.rateLimits,
      }]);
    }
    if (panel.usage.behaviors) {
      html += configSection('Limit contributors', [{
        key: 'Behaviors',
        value: panel.usage.behaviors,
      }]);
    }
    return html;
  }

  function dateKey(date) {
    return date.getFullYear() + '-'
      + String(date.getMonth() + 1).padStart(2, '0') + '-'
      + String(date.getDate()).padStart(2, '0');
  }

  function heatmap(range, today) {
    var count = range.key === '7d' ? 7 : (range.key === '30d' ? 30 : 365);
    var end = today ? new Date(today + 'T12:00:00') : new Date();
    end.setHours(12, 0, 0, 0);
    var start = new Date(end);
    start.setDate(start.getDate() - count + 1);
    if (range.key === 'all') start.setDate(start.getDate() - start.getDay());
    var values = Object.create(null);
    var units = Object.create(null);
    var max = 0;
    (range.days || []).forEach(function (day) {
      var tokens = Number(day.tokens) || 0;
      var activity = tokens || Number(day.sessions) || 0;
      values[day.date] = activity;
      units[day.date] = tokens ? 'tokens' : 'sessions';
      if (activity > max) max = activity;
    });
    var cells = [];
    for (var cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
      var key = dateKey(cursor);
      var value = values[key] || 0;
      var level = value && max ? Math.max(1, Math.ceil((value / max) * 4)) : 0;
      cells.push('<span class="cc-heat-cell level-' + level + '" title="' + esc(key)
        + ': ' + esc(compactNumber(value)) + ' ' + esc(units[key] || 'tokens') + '"></span>');
    }
    return '<div class="cc-heat-scroll"><div class="cc-heatmap">' + cells.join('')
      + '</div></div><div class="cc-heat-legend"><span>Less</span>'
      + '<i class="level-0"></i><i class="level-1"></i><i class="level-2"></i>'
      + '<i class="level-3"></i><i class="level-4"></i><span>More</span></div>';
  }

  function summary(range) {
    var item = range.summary || {};
    var cards = [
      ['Total tokens', compactNumber(item.totalTokens)],
      ['Sessions', compactNumber(item.sessions)],
      ['Active days', compactNumber(item.activeDays) + '/' + compactNumber(item.periodDays)],
      ['Longest session', duration(item.longestSessionMs)],
      ['Longest streak', compactNumber(item.longestStreak) + ' days'],
      ['Current streak', compactNumber(item.currentStreak) + ' days'],
      ['Most active day', item.mostActiveDay || '—'],
    ];
    return '<div class="cc-stat-grid">' + cards.map(function (card) {
      return '<div><span>' + esc(card[0]) + '</span><strong>' + esc(card[1]) + '</strong></div>';
    }).join('') + '</div>';
  }

  function overview(range, today) {
    var breakdown = range.tokenBreakdown || {};
    return heatmap(range, today) + summary(range)
      + '<div class="cc-token-breakdown">'
      + '<span>Input <strong>' + esc(compactNumber(breakdown.input)) + '</strong></span>'
      + '<span>Output <strong>' + esc(compactNumber(breakdown.output)) + '</strong></span>'
      + '<span>Cache write <strong>' + esc(compactNumber(breakdown.cacheCreation)) + '</strong></span>'
      + '<span>Cache read <strong>' + esc(compactNumber(breakdown.cacheRead)) + '</strong></span>'
      + '</div>';
  }

  function chartTickLabel(label, unit) {
    if (unit === 'day') return String(label).slice(5);
    return String(label);
  }

  function modelChart(chart) {
    var labels = chart && chart.labels || [];
    var series = chart && chart.series || [];
    if (!labels.length || !series.length) return '';
    var colors = ['#58a6ff', '#3fb950', '#d29922', '#f778ba', '#39c5cf', '#8b949e'];
    var width = 680;
    var height = 250;
    var left = 62;
    var right = 16;
    var top = 14;
    var bottom = 38;
    var plotWidth = width - left - right;
    var plotHeight = height - top - bottom;
    var max = 0;
    series.forEach(function (item) {
      (item.values || []).forEach(function (value) {
        max = Math.max(max, Number(value) || 0);
      });
    });
    if (!max) return '';
    var magnitude = Math.pow(10, Math.floor(Math.log10(max)));
    var normalized = max / magnitude;
    var niceMax = (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10)
      * magnitude;
    var x = function (index) {
      return left + (labels.length === 1 ? plotWidth / 2 : (index / (labels.length - 1)) * plotWidth);
    };
    var y = function (value) {
      return top + plotHeight - ((Number(value) || 0) / niceMax) * plotHeight;
    };
    var yGrid = [0, 0.25, 0.5, 0.75, 1].map(function (ratio) {
      var position = top + plotHeight - ratio * plotHeight;
      return '<line x1="' + left + '" y1="' + position + '" x2="' + (width - right)
        + '" y2="' + position + '"></line><text x="' + (left - 8) + '" y="'
        + (position + 4) + '" text-anchor="end">' + esc(compactNumber(niceMax * ratio))
        + '</text>';
    }).join('');
    var xIndexes = [];
    var tickCount = Math.min(5, labels.length);
    for (var tick = 0; tick < tickCount; tick++) {
      var index = Math.round((tick / Math.max(1, tickCount - 1)) * (labels.length - 1));
      if (xIndexes.indexOf(index) === -1) xIndexes.push(index);
    }
    var xTicks = xIndexes.map(function (index) {
      return '<text x="' + x(index) + '" y="' + (height - 10) + '" text-anchor="middle">'
        + esc(chartTickLabel(labels[index], chart.unit)) + '</text>';
    }).join('');
    var paths = series.map(function (item, seriesIndex) {
      var color = colors[seriesIndex % colors.length];
      var points = (item.values || []).map(function (value, index) {
        return x(index).toFixed(1) + ',' + y(value).toFixed(1);
      }).join(' ');
      var dots = labels.length <= 31 ? (item.values || []).map(function (value, index) {
        if (!(Number(value) || 0)) return '';
        return '<circle cx="' + x(index).toFixed(1) + '" cy="' + y(value).toFixed(1)
          + '" r="2.5" fill="' + color + '"><title>' + esc(item.label) + ' · '
          + esc(labels[index]) + ': ' + esc(compactNumber(value)) + ' tokens</title></circle>';
      }).join('') : '';
      return '<polyline points="' + points + '" fill="none" stroke="' + color
        + '" stroke-width="2" vector-effect="non-scaling-stroke"></polyline>' + dots;
    }).join('');
    var legend = series.map(function (item, index) {
      return '<span><i style="background:' + colors[index % colors.length] + '"></i>'
        + esc(item.label) + '</span>';
    }).join('');
    return '<div class="cc-model-chart-block"><div class="cc-model-chart-title">'
      + '<strong>Model usage over time</strong><span>Tokens</span></div>'
      + '<div class="cc-model-chart-scroll"><svg class="cc-model-chart" viewBox="0 0 '
      + width + ' ' + height + '" role="img" aria-label="Model token usage over time">'
      + '<g class="cc-chart-grid">' + yGrid + xTicks + '</g>'
      + '<line class="cc-chart-axis" x1="' + left + '" y1="' + top + '" x2="' + left
      + '" y2="' + (top + plotHeight) + '"></line><line class="cc-chart-axis" x1="'
      + left + '" y1="' + (top + plotHeight) + '" x2="' + (width - right) + '" y2="'
      + (top + plotHeight) + '"></line>' + paths + '</svg></div>'
      + '<div class="cc-model-legend">' + legend + '</div></div>';
  }

  function models(range) {
    var list = range.models || [];
    if (!list.length) return '<div class="cc-empty">No model usage recorded</div>';
    var max = Math.max.apply(null, list.map(function (model) { return Number(model.total) || 0; }));
    return modelChart(range.modelChart) + '<div class="cc-model-list">' + list.map(function (model) {
      var width = max ? Math.max(2, Math.round(((Number(model.total) || 0) / max) * 100)) : 0;
      return '<div class="cc-model-row"><div class="cc-model-heading"><strong>'
        + esc(model.label || model.id) + '</strong><span>' + esc(compactNumber(model.total))
        + ' tokens</span></div><div class="cc-model-bar"><i style="width:' + width
        + '%"></i></div><div class="cc-model-detail">'
        + '<span>in ' + esc(compactNumber(model.input)) + '</span>'
        + '<span>out ' + esc(compactNumber(model.output)) + '</span>'
        + '<span>cache ' + esc(compactNumber((model.cacheCreation || 0) + (model.cacheRead || 0)))
        + '</span></div></div>';
    }).join('') + '</div>';
  }

  function statsTab(panel) {
    var ranges = panel.stats.ranges || [];
    return '<div class="cc-stats-toolbar">'
      + '<div class="cc-subtabs" role="tablist">'
      + '<button class="active" type="button" onclick="switchClaudeStatsView(this,\'overview\')">Overview</button>'
      + '<button type="button" onclick="switchClaudeStatsView(this,\'models\')">Models</button></div>'
      + '<div class="cc-range-tabs">' + ranges.map(function (range, index) {
        return '<button class="' + (index === 0 ? 'active' : '') + '" type="button" data-range="'
          + esc(range.key) + '" onclick="switchClaudeStatsRange(this,\'' + esc(range.key) + '\')">'
          + esc(range.label) + '</button>';
      }).join('') + '</div></div>'
      + '<div class="cc-stats-ranges">' + ranges.map(function (range, index) {
        return '<div class="cc-stats-range' + (index === 0 ? ' active' : '')
          + '" data-range="' + esc(range.key) + '">'
          + '<div class="cc-stats-view active" data-view="overview">'
          + overview(range, panel.stats.today) + '</div>'
          + '<div class="cc-stats-view" data-view="models">' + models(range) + '</div></div>';
      }).join('') + '</div>';
  }

  function copyIcon() {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"></rect>'
      + '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
  }

  window.renderClaudeUsagePanel = function (panel) {
    var id = 'cc-usage-' + Math.random().toString(36).slice(2, 10);
    panels[id] = panel;
    var tabs = ['status', 'config', 'usage', 'stats'];
    var initial = tabs.indexOf(panel.initialTab) === -1 ? 'usage' : panel.initialTab;
    var content = {
      status: statusTab(panel),
      config: configTab(panel),
      usage: usageTab(panel),
      stats: statsTab(panel),
    };
    return '<div class="cc-usage-panel" data-panel-id="' + id + '"><div class="cc-panel-header">'
      + '<div class="cc-panel-tabs" role="tablist">' + tabs.map(function (tab) {
        return '<button type="button" class="' + (tab === initial ? 'active' : '')
          + '" onclick="switchClaudeUsageTab(this,\'' + tab + '\')">'
          + tab.charAt(0).toUpperCase() + tab.slice(1) + '</button>';
      }).join('') + '</div><button class="cc-panel-copy" type="button" title="Copy as text" '
      + 'aria-label="Copy as text" onclick="copyClaudeUsagePanel(this)">' + copyIcon()
      + '</button></div><div class="cc-panel-body">' + tabs.map(function (tab) {
        return '<section class="cc-panel-tab' + (tab === initial ? ' active' : '')
          + '" data-tab="' + tab + '">' + content[tab] + '</section>';
      }).join('') + '</div></div>';
  };

  window.switchClaudeUsageTab = function (button, tab) {
    var panel = button.closest('.cc-usage-panel');
    if (!panel) return;
    panel.querySelectorAll('.cc-panel-tabs button').forEach(function (item) {
      item.classList.toggle('active', item === button);
    });
    panel.querySelectorAll('.cc-panel-tab').forEach(function (item) {
      item.classList.toggle('active', item.dataset.tab === tab);
    });
  };

  window.switchClaudeStatsView = function (button, view) {
    var panel = button.closest('.cc-usage-panel');
    if (!panel) return;
    panel.querySelectorAll('.cc-subtabs button').forEach(function (item) {
      item.classList.toggle('active', item === button);
    });
    panel.querySelectorAll('.cc-stats-view').forEach(function (item) {
      item.classList.toggle('active', item.dataset.view === view);
    });
  };

  window.switchClaudeStatsRange = function (button, range) {
    var panel = button.closest('.cc-usage-panel');
    if (!panel) return;
    panel.querySelectorAll('.cc-range-tabs button').forEach(function (item) {
      item.classList.toggle('active', item === button);
    });
    panel.querySelectorAll('.cc-stats-range').forEach(function (item) {
      item.classList.toggle('active', item.dataset.range === range);
    });
  };

  window.copyClaudeUsagePanel = function (button) {
    var panel = button.closest('.cc-usage-panel');
    var data = panel && panels[panel.dataset.panelId];
    if (!data || !navigator.clipboard?.writeText) return;
    navigator.clipboard.writeText(data.rawText || '').then(function () {
      button.classList.add('copied');
      button.setAttribute('title', 'Copied');
      setTimeout(function () {
        button.classList.remove('copied');
        button.setAttribute('title', 'Copy as text');
      }, 1200);
    }).catch(function () {});
  };
})();
