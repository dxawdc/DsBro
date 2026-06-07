/**
 * electron-builder afterPack hook
 * 在打包成 portable/installer 之前清理不需要的文件，减小包体
 */
exports.default = async function (context) {
  const fs = require('fs');
  const path = require('path');
  const { appOutDir } = context;

  // ── 精简语言包：只保留中文（其他语言包对国内用户无用） ──
  const localesDir = path.join(appOutDir, 'locales');
  try {
    const files = fs.readdirSync(localesDir);
    let removedLocales = 0;
    for (const file of files) {
      if (file !== 'zh-CN.pak') {
        const filePath = path.join(localesDir, file);
        const stat = fs.statSync(filePath);
        fs.unlinkSync(filePath);
        removedLocales++;
        console.log(`  [locale] removed ${file} (${(stat.size / 1024).toFixed(0)}KB)`);
      }
    }
    console.log(`  [locale] kept zh-CN.pak only, removed ${removedLocales} locale files`);
  } catch {
    // no locales dir
  }

  // ── 计算清理后总大小 ──
  function dirSize(dir) {
    let total = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) total += dirSize(full);
      else total += fs.statSync(full).size;
    }
    return total;
  }
  const finalSize = dirSize(appOutDir);
  console.log(`  [size] final app directory: ${(finalSize / 1024 / 1024).toFixed(0)}MB`);
};
