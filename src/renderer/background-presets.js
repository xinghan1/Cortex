'use strict';

// Bundled CSS backgrounds: no downloads, image uploads or model requests.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ForgeBackgroundPresets = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  const presets = {
    aurora: {
      name: '极光 · 默认背景', description: '柔和蓝紫渐变，专注于眼前的创作。',
      image: 'url("./aurora-background.svg")',
    },
    rose: {
      name: '玫瑰 · 红色背景', description: '玫瑰红与莓紫的柔和光晕。',
      image: 'radial-gradient(ellipse at 18% 20%, #ef738c 0%, transparent 60%), radial-gradient(ellipse at 85% 82%, #9e315e 0%, transparent 65%), linear-gradient(135deg, #301322, #160b1e)',
    },
    amber: {
      name: '暖金 · 黄色背景', description: '暖金与琥珀交融，温暖而安静。',
      image: 'radial-gradient(ellipse at 18% 18%, #f4d777 0%, transparent 62%), radial-gradient(ellipse at 88% 80%, #bf743a 0%, transparent 68%), linear-gradient(135deg, #35271a, #18101a)',
    },
    forest: {
      name: '森林 · 绿色背景', description: '翡翠绿与深林色，清新柔和。',
      image: 'radial-gradient(ellipse at 20% 16%, #64cda4 0%, transparent 62%), radial-gradient(ellipse at 84% 84%, #19795e 0%, transparent 67%), linear-gradient(135deg, #112e2a, #071820)',
    },
    ocean: {
      name: '海蓝 · 蓝色背景', description: '海蓝与冰蓝的开阔渐变。',
      image: 'radial-gradient(ellipse at 16% 20%, #78cfff 0%, transparent 62%), radial-gradient(ellipse at 88% 82%, #3a62bc 0%, transparent 66%), linear-gradient(135deg, #10335a, #08132e)',
    },
    snow: {
      name: '霜白 · 白色背景', description: '柔和白色与淡蓝光晕，明净轻盈。',
      image: 'radial-gradient(ellipse at 18% 18%, #ffffff 0%, transparent 68%), radial-gradient(ellipse at 85% 82%, #dae7f8 0%, transparent 70%), linear-gradient(135deg, #f9fbff, #edf1f7)',
    },
    midnight: {
      name: '深夜 · 黑色背景', description: '石墨黑与微弱蓝灰，沉静专注。',
      image: 'radial-gradient(ellipse at 18% 18%, #26303f 0%, transparent 65%), radial-gradient(ellipse at 86% 85%, #191d2b 0%, transparent 70%), linear-gradient(135deg, #090c13, #030509)',
    },
    orange: {
      name: '橙光 · 橙色背景', description: '明亮橙光与暖棕渐变，温暖鲜活。',
      image: 'radial-gradient(ellipse at 18% 18%, #ffae69 0%, transparent 62%), radial-gradient(ellipse at 86% 82%, #dc692c 0%, transparent 68%), linear-gradient(135deg, #542316, #211016)',
    },
    purple: {
      name: '紫雾 · 紫色背景', description: '薰衣草紫与深紫交融，柔和静谧。',
      image: 'radial-gradient(ellipse at 18% 18%, #b3a0f4 0%, transparent 62%), radial-gradient(ellipse at 86% 82%, #7241b8 0%, transparent 68%), linear-gradient(135deg, #302044, #140d27)',
    },
    olive: {
      name: '橄榄 · 橄榄绿背景', description: '橄榄绿与苔藓金，沉静自然。',
      image: 'radial-gradient(ellipse at 18% 18%, #c1cb7b 0%, transparent 62%), radial-gradient(ellipse at 86% 82%, #7c8542 0%, transparent 68%), linear-gradient(135deg, #333a20, #141c13)',
    },
    pink: {
      name: '樱粉 · 粉色背景', description: '轻柔樱粉与暖玫瑰，明媚轻盈。',
      image: 'radial-gradient(ellipse at 18% 18%, #ffd0e1 0%, transparent 62%), radial-gradient(ellipse at 86% 82%, #ee8db8 0%, transparent 68%), linear-gradient(135deg, #7a3c61, #321b38)',
    },
    magenta: {
      name: '霓彩 · 品红背景', description: '品红与莓紫光晕，鲜明而柔和。',
      image: 'radial-gradient(ellipse at 18% 18%, #f68ee8 0%, transparent 62%), radial-gradient(ellipse at 86% 82%, #c62bb0 0%, transparent 68%), linear-gradient(135deg, #581447, #210d2a)',
    },
    cyan: {
      name: '清青 · 青色背景', description: '清澈青色与深青渐变，清凉通透。',
      image: 'radial-gradient(ellipse at 18% 18%, #8cebed 0%, transparent 62%), radial-gradient(ellipse at 86% 82%, #25a5ac 0%, transparent 68%), linear-gradient(135deg, #164851, #082328)',
    },
  };
  for (const [id, value] of Object.entries(presets)) presets[id] = Object.freeze({ id, ...value });
  Object.freeze(presets);
  const normalize = value => Object.hasOwn(presets, value) ? value : 'aurora';
  const get = value => presets[normalize(value)];
  return Object.freeze({ normalize, get });
});
