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
