// usage: cartrim <in.car> <out.car> <mode>
// mode: list | dropicons | dropall | keep:<substring>
#import <Foundation/Foundation.h>
#import <dlfcn.h>
#import <objc/runtime.h>
@interface NSObject (CUI)
- (id)initWithPath:(NSString *)p forWriting:(BOOL)w;
- (NSArray *)allAssetKeys;
- (NSData *)assetForKey:(NSData *)k;
- (void)removeAssetForKey:(NSData *)k;
- (BOOL)writeToDiskAndCompact:(BOOL)c;
- (const void *)keyList;
- (const void *)keyFormat;
@end
typedef struct { uint32_t tag, version, count; uint32_t tokens[]; } kfmt;
typedef struct { uint16_t identifier, value; } ktok;
static NSData *keyData(id s, id rk) {
  if ([rk isKindOfClass:[NSData class]]) return rk;
  const kfmt *f = [s keyFormat]; const ktok *t = [rk keyList];
  NSMutableData *d = [NSMutableData data];
  for (uint32_t i = 0; i < f->count; i++) { uint16_t v = 0; for (const ktok *p = t; p->identifier; p++) if (p->identifier == f->tokens[i]) { v = p->value; break; } [d appendBytes:&v length:2]; }
  return d;
}
static NSString *fourcc(uint32_t v) { char c[5] = { (char)(v >> 24), (char)(v >> 16), (char)(v >> 8), (char)v, 0 }; return [NSString stringWithUTF8String:c] ?: @"?"; }
static void dumpMethods(Class c) { unsigned n; Method *m = class_copyMethodList(c, &n); for (unsigned i = 0; i < n; i++) printf("  %s\n", sel_getName(method_getName(m[i]))); }
int main(int argc, char **argv) {
  @autoreleasepool {
    dlopen("/System/Library/PrivateFrameworks/CoreUI.framework/CoreUI", RTLD_NOW);
    NSString *in = @(argv[1]), *out = @(argv[2]), *mode = @(argv[3]);
    [[NSFileManager defaultManager] removeItemAtPath:out error:nil];
    [[NSFileManager defaultManager] copyItemAtPath:in toPath:out error:nil];
    Class C = NSClassFromString(@"CUIMutableCommonAssetStorage");
    if (!C) { printf("no CUIMutableCommonAssetStorage\n"); return 1; }
    id s = [[C alloc] initWithPath:out forWriting:YES];
    if (!s) { printf("open failed\n"); dumpMethods(C); return 1; }
    if (getenv("DUMP")) { for (NSString *cn in @[@"CUICommonAssetStorage", @"CUIMutableCommonAssetStorage", @"CUIRenditionKey"]) { printf("== %s\n", cn.UTF8String); dumpMethods(NSClassFromString(cn)); } }
    NSArray *keys = [s allAssetKeys];
    NSMutableArray *drop = [NSMutableArray array];
    for (id rk in keys) {
      NSData *k = keyData(s, rk);
      NSData *d = [s assetForKey:k];
      const uint8_t *b = d.bytes; NSString *name = @"?"; uint32_t w = 0, h = 0, sc = 0, pf = 0, comp = 0xffffffff;
      if (d.length > 184 && memcmp(b, "ISTC", 4) == 0) {
        w = *(uint32_t *)(b + 12); h = *(uint32_t *)(b + 16); sc = *(uint32_t *)(b + 20); pf = *(uint32_t *)(b + 24);
        name = [[NSString alloc] initWithBytes:b + 40 length:strnlen((const char *)b + 40, 128) encoding:NSUTF8StringEncoding] ?: @"?";
        for (NSUInteger i = 184; i + 12 < d.length; i++) if (!memcmp(b + i, "MLEC", 4) || !memcmp(b + i, "KCBC", 4)) { comp = *(uint32_t *)(b + i + 8); break; }
      }
      printf("%-100s %4ux%-4u s%u %s comp=%d bytes=%lu\n", name.UTF8String, w, h, sc, fourcc(pf).UTF8String, (int)comp, (unsigned long)d.length);
      BOOL flat = [name hasPrefix:@"Icon"] && [name containsString:@"_NSAppearanceName"];
      BOOL packed = [name hasPrefix:@"ZZZZPackedAsset"];
      if ([mode isEqualToString:@"dropicons"] && flat) [drop addObject:k];
      if ([mode isEqualToString:@"dropall"] && (flat || packed)) [drop addObject:k];
      if ([mode hasPrefix:@"keep:"] && (flat || packed) && ![name containsString:[mode substringFromIndex:5]]) [drop addObject:k];
    }
    if ([mode isEqualToString:@"list"]) return 0;
    for (NSData *k in drop) [s removeAssetForKey:k];
    BOOL ok = [s writeToDiskAndCompact:YES];
    NSDictionary *a = [[NSFileManager defaultManager] attributesOfItemAtPath:out error:nil];
    printf("mode=%s dropped=%lu write=%d size=%llu\n", mode.UTF8String, (unsigned long)drop.count, ok, [a fileSize]);
  }
  return 0;
}
