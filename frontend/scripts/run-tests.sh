#!/bin/sh
# 督办批领域逻辑测试：tsc 把相关 TS 源转成 CJS 到 scripts/tmp，修正 @ 别名后用 node 跑。
set -e
cd "$(dirname "$0")/.."
rm -rf scripts/tmp
npx tsc -p tsconfig.test.json
sed -i 's#require("@/data/#require("../data/#g' scripts/tmp/api/supervision.js
# 项目 package.json 声明了 type: module，临时产物改用 .cjs 扩展名。
find scripts/tmp -name '*.js' | while read f; do mv "$f" "${f%.js}.cjs"; done
sed -i 's#require("../data/local-store")#require("../data/local-store.cjs")#' scripts/tmp/api/supervision.cjs
sed -i 's#require("./seed")#require("./seed.cjs")#' scripts/tmp/data/local-store.cjs
node scripts/test-supervision.cjs
rm -rf scripts/tmp
