// Skeleton loading placeholders

function skeletonCards(n) {
  var cards = '';
  for (var i = 0; i < n; i++) {
    cards += '<div class="active-card skeleton-card">'
      + '<div class="card-header"><span class="skel skel-w40"></span><span class="skel skel-w16"></span></div>'
      + '<div class="card-title"><span class="skel skel-w80 skel-h14"></span></div>'
      + '<div class="card-bottom"><span class="skel skel-w24"></span><span class="skel skel-w16"></span></div>'
      + '</div>';
  }
  return cards;
}

function skeletonMessages() {
  return '<div class="messages skeleton-messages">'
    + '<div class="msg-user skeleton-user">'
      + '<div class="skeleton-copy-line"><span class="skel skel-w60 skel-h14"></span></div>'
      + '<div class="msg-meta skeleton-msg-meta"><span class="skel skeleton-meta-bar"></span></div>'
    + '</div>'
    + '<div class="assistant-turn">'
      + '<div class="tl-item assistant-text skeleton-copy"><div class="skeleton-copy-line"><span class="skel skel-w80 skel-h14"></span></div><div class="skeleton-copy-line"><span class="skel skel-w40 skel-h14"></span></div></div>'
      + '<div class="tl-item tool-node tool-details-collapsed skeleton-tool"><div class="tool-header"><span class="skel skel-w40 skel-h14"></span><span class="skel skel-w24"></span></div></div>'
      + '<div class="tl-item assistant-text skeleton-copy"><div class="skeleton-copy-line"><span class="skel skel-w60 skel-h14"></span></div></div>'
    + '</div>'
    + '<div class="msg-user skeleton-user">'
      + '<div class="skeleton-copy-line"><span class="skel skel-w40 skel-h14"></span></div>'
      + '<div class="msg-meta skeleton-msg-meta"><span class="skel skeleton-meta-bar"></span></div>'
    + '</div>'
    + '<div class="assistant-turn">'
      + '<div class="tl-item thinking-tl skeleton-thinking"><div class="thinking-block"><div class="thinking-toggle"><span class="skel skel-w40"></span></div></div></div>'
      + '<div class="tl-item tool-node tool-details-collapsed skeleton-tool"><div class="tool-header"><span class="skel skel-w60 skel-h14"></span><span class="skel skel-w16"></span></div></div>'
      + '<div class="tl-item assistant-text skeleton-copy"><div class="skeleton-copy-line"><span class="skel skel-w80 skel-h14"></span></div></div>'
    + '</div>'
    + '</div>';
}

function skeletonItems(n, type) {
  type = type === 'project' ? 'project' : type === 'device' ? 'device' : 'session';
  var items = '';
  for (var i = 0; i < n; i++) {
    if (type === 'project') {
      items += '<div class="item project-item skeleton-item skeleton-item-project"><div class="item-main">'
        + '<div class="item-top"><span class="skel skel-w40"></span><span class="skel skel-w16"></span></div>'
        + '<div class="subtitle"><span class="skel skel-w60"></span></div>'
        + '<div class="item-bottom"><span class="skel skel-w24"></span><span class="skel skel-w40"></span></div>'
        + '</div></div>';
    } else if (type === 'session') {
      items += '<div class="item session-item skeleton-item skeleton-item-session"><div class="item-main">'
        + '<div class="item-top"><span class="skel skel-w40"></span><span class="skel skel-w16"></span></div>'
        + '<div class="item-bottom session-item-bottom"><span class="skel skel-w60"></span><span class="skel skel-w24"></span></div>'
        + '</div></div>';
    } else {
      items += '<div class="item device-item skeleton-item skeleton-item-device">'
        + '<div class="item-top"><span class="skel skel-w40"></span><span class="skel skel-w16"></span></div>'
        + '<div class="item-bottom"><span class="skel skel-w60"></span><span class="skel skel-w24"></span></div>'
        + '</div>';
    }
  }
  return items;
}

Object.assign(window, { skeletonCards, skeletonMessages, skeletonItems });
