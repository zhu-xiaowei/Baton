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
@end
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
    NSArray *keys = [s allAssetKeys];
    NSMutableArray *drop = [NSMutableArray array];
    for (NSData *k in keys) {
      NSData *d = [s assetForKey:k];
      const uint8_t *b = d.bytes; NSString *name = @"?"; uint32_t w = 0, h = 0, sc = 0, pf = 0, comp = 0xffffffff;
      if (d.length > 184 && memcmp(b, "ISTC", 4) == 0) {
        w = *(uint32_t *)(b + 12); h = *(uint32_t *)(b + 16); sc = *(uint32_t *)(b + 20); pf = *(uint32_t *)(b + 24);
        name = [[NSString alloc] initWithBytes:b + 40 length:strnlen((const char *)b + 40, 128) encoding:NSUTF8StringEncoding] ?: @"?";
        for (NSUInteger i = 184; i + 12 < d.length; i++) if (!memcmp(b + i, "MLEC", 4) || !memcmp(b + i, "KCBC", 4)) { comp = *(uint32_t *)(b + i + 8); break; }
      }
      printf("%-110s %4ux%-4u s%u %@ comp=%d bytes=%lu\n", name.UTF8String, w, h, sc, fourcc(pf).UTF8String ? fourcc(pf) : @"", (int)comp, (unsigned long)d.length);
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
