// CloudFront Function — viewer-request
// Wymusza 301 (zamiast domyślnego S3 302) dla ścieżek bez końcowego slasha
// (oprócz plików z rozszerzeniem).
//
// Deploy:
//   1. AWS Console → CloudFront → Functions → Create Function
//      Name: trailing-slash-301
//      Runtime: cloudfront-js-2.0
//   2. Wklej zawartość tego pliku → Save → Publish.
//   3. Distribution E35OASC384C0TF → Behavior(s) → Edit
//      Function associations → Viewer Request → Function type: CloudFront Functions
//      Function ARN: arn:aws:cloudfront::<account>:function/trailing-slash-301
//   4. Save → po deployu wykonać: aws cloudfront create-invalidation --distribution-id E35OASC384C0TF --paths "/*"

function handler(event) {
  var request = event.request;
  var uri = request.uri;

  // Root '/' i pliki (cokolwiek z kropką w ostatnim segmencie) zostawiamy.
  if (uri === '/' || /\.[a-zA-Z0-9]+$/.test(uri)) {
    return request;
  }

  // Jeśli już kończy się slashem — przepuszczamy.
  if (uri.slice(-1) === '/') {
    return request;
  }

  // Inaczej — 301 do wersji z trailing slashem (zachowując querystring).
  var qs = '';
  if (request.querystring) {
    var pairs = [];
    for (var key in request.querystring) {
      var val = request.querystring[key];
      if (val.multiValue) {
        for (var i = 0; i < val.multiValue.length; i++) {
          pairs.push(encodeURIComponent(key) + '=' + encodeURIComponent(val.multiValue[i].value));
        }
      } else {
        pairs.push(encodeURIComponent(key) + '=' + encodeURIComponent(val.value));
      }
    }
    if (pairs.length > 0) qs = '?' + pairs.join('&');
  }

  return {
    statusCode: 301,
    statusDescription: 'Moved Permanently',
    headers: {
      location: { value: uri + '/' + qs },
      'cache-control': { value: 'public, max-age=3600' }
    }
  };
}
