// Skeleton loading placeholders

function skeletonCards(n) {
  var cards = '';
  for (var i = 0; i < n; i++) {
    cards += '<div class="active-card skeleton-card">'
      + '<div class="card-header"><span class="skel skel-w40"></span><span class="skel skel-w16"></span></div>'
      + '<div class="skel skel-w80 skel-h14"></div>'
      + '<div class="card-bottom"><span class="skel skel-w24"></span><span class="skel skel-w16"></span></div>'
      + '</div>';
  }
  return cards;
}

function skeletonMessages() {
  return '<div class="messages skeleton-messages">'
    + '<div class="msg-user"><div class="skel skel-w60 skel-h14"></div></div>'
    + '<div class="assistant-turn">'
      + '<div class="tl-item assistant-text"><div class="skel skel-w80 skel-h14"></div><div class="skel skel-w40 skel-h14 skel-mt4"></div></div>'
      + '<div class="tl-item tool-node"><div class="skel skel-w40 skel-h14"></div></div>'
      + '<div class="tl-item assistant-text"><div class="skel skel-w60 skel-h14"></div></div>'
    + '</div>'
    + '<div class="msg-user"><div class="skel skel-w40 skel-h14"></div></div>'
    + '<div class="assistant-turn">'
      + '<div class="tl-item assistant-text"><div class="skel skel-w80 skel-h14"></div></div>'
      + '<div class="tl-item tool-node"><div class="skel skel-w60 skel-h14"></div></div>'
    + '</div>'
    + '</div>';
}

function skeletonItems(n) {
  var items = '';
  for (var i = 0; i < n; i++) {
    items += '<div class="item skeleton-item">'
      + '<div class="item-top"><span class="skel skel-w40"></span><span class="skel skel-w16"></span></div>'
      + '<div class="skel skel-w60 skel-mt4"></div>'
      + '</div>';
  }
  return items;
}

Object.assign(window, { skeletonCards, skeletonMessages, skeletonItems });
