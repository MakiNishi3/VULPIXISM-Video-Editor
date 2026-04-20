
const Studio = (() => {
  let canvas, gl, ctx2d, useWebGL = false;
  let layers = [], tracks = [], currentFrame = 0, totalFrames = 300, fps = 30;
  let selectedLayer = null, isPlaying = false, animationId = null;
  let uiRoot = null, menuRoot = null;
  let activeEffects = new Map();
  let exportQueue = [];

  const MEDIABUNNY_API = "https://api.mediabunny.com/v1";
  const MEDIABUNNY_KEY = "";

  function initWebGL(c) {
    gl = c.getContext("webgl2") || c.getContext("webgl");
    if (!gl) return false;
    gl.viewport(0, 0, c.width, c.height);
    gl.clearColor(0, 0, 0, 0);
    return true;
  }

  function createShaderProgram(vertSrc, fragSrc) {
    const vert = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vert, vertSrc);
    gl.compileShader(vert);
    const frag = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(frag, fragSrc);
    gl.compileShader(frag);
    const prog = gl.createProgram();
    gl.attachShader(prog, vert);
    gl.attachShader(prog, frag);
    gl.linkProgram(prog);
    return prog;
  }

  const BASE_VERT = `
    attribute vec2 a_position;
    attribute vec2 a_texCoord;
    varying vec2 v_texCoord;
    void main() {
      gl_Position = vec4(a_position, 0.0, 1.0);
      v_texCoord = a_texCoord;
    }
  `;

  const shaders = {
    tint: (r, g, b, amount) => `
      precision mediump float;
      uniform sampler2D u_texture;
      varying vec2 v_texCoord;
      void main() {
        vec4 color = texture2D(u_texture, v_texCoord);
        vec3 tint = vec3(${r.toFixed(3)}, ${g.toFixed(3)}, ${b.toFixed(3)});
        color.rgb = mix(color.rgb, color.rgb * tint, ${amount.toFixed(3)});
        gl_FragColor = color;
      }
    `,
    tzatzikiLens: (strength, centerX, centerY) => `
      precision mediump float;
      uniform sampler2D u_texture;
      varying vec2 v_texCoord;
      void main() {
        vec2 center = vec2(${centerX.toFixed(3)}, ${centerY.toFixed(3)});
        vec2 uv = v_texCoord - center;
        float dist = length(uv);
        float k = ${strength.toFixed(3)};
        float factor = 1.0 + k * dist * dist;
        vec2 distorted = uv / factor + center;
        gl_FragColor = texture2D(u_texture, distorted);
      }
    `,
    turbulentDisplace: (scale, intensity, time) => `
      precision mediump float;
      uniform sampler2D u_texture;
      varying vec2 v_texCoord;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p); vec2 f = fract(p);
        float a = hash(i), b = hash(i+vec2(1,0)), c = hash(i+vec2(0,1)), d = hash(i+vec2(1,1));
        vec2 u = f*f*(3.0-2.0*f);
        return mix(a,b,u.x) + (c-a)*u.y*(1.0-u.x) + (d-b)*u.x*u.y;
      }
      void main() {
        float t = ${time.toFixed(3)};
        float sc = ${scale.toFixed(3)};
        float inten = ${intensity.toFixed(3)};
        vec2 uv = v_texCoord;
        float nx = noise(uv * sc + vec2(t, 0.0));
        float ny = noise(uv * sc + vec2(0.0, t + 1.7));
        vec2 displaced = uv + vec2(nx - 0.5, ny - 0.5) * inten;
        gl_FragColor = texture2D(u_texture, displaced);
      }
    `,
    wiggle: (amountX, amountY, speed, time) => `
      precision mediump float;
      uniform sampler2D u_texture;
      varying vec2 v_texCoord;
      void main() {
        float t = ${time.toFixed(3)} * ${speed.toFixed(3)};
        vec2 offset = vec2(sin(t * 6.2831) * ${amountX.toFixed(3)}, cos(t * 6.2831) * ${amountY.toFixed(3)});
        gl_FragColor = texture2D(u_texture, v_texCoord + offset);
      }
    `,
    noise: (intensity, scale, time) => `
      precision mediump float;
      uniform sampler2D u_texture;
      varying vec2 v_texCoord;
      float rand(vec2 co) { return fract(sin(dot(co, vec2(12.9898,78.233))) * 43758.5453); }
      void main() {
        vec4 color = texture2D(u_texture, v_texCoord);
        float n = rand(v_texCoord + ${time.toFixed(3)}) * ${intensity.toFixed(3)};
        color.rgb += n;
        gl_FragColor = color;
      }
    `,
    meshGlitch: (amount, time) => `
      precision mediump float;
      uniform sampler2D u_texture;
      varying vec2 v_texCoord;
      float rand(float x) { return fract(sin(x) * 43758.5453); }
      void main() {
        vec2 uv = v_texCoord;
        float t = floor(${time.toFixed(3)} * 10.0) / 10.0;
        float sliceY = floor(uv.y * 20.0) / 20.0;
        float r = rand(sliceY + t);
        if (r > 0.85) uv.x += (rand(sliceY + t + 0.1) - 0.5) * ${amount.toFixed(3)};
        float r2 = rand(sliceY * 2.0 + t);
        vec2 uvR = uv + vec2((r2 - 0.5) * 0.01, 0.0);
        vec2 uvB = uv - vec2((r2 - 0.5) * 0.01, 0.0);
        float red = texture2D(u_texture, uvR).r;
        float green = texture2D(u_texture, uv).g;
        float blue = texture2D(u_texture, uvB).b;
        float alpha = texture2D(u_texture, uv).a;
        gl_FragColor = vec4(red, green, blue, alpha);
      }
    `,
    glitch: (amount, time) => `
      precision mediump float;
      uniform sampler2D u_texture;
      varying vec2 v_texCoord;
      float rand(vec2 co) { return fract(sin(dot(co, vec2(12.9898,78.233))) * 43758.5453); }
      void main() {
        vec2 uv = v_texCoord;
        float t = floor(${time.toFixed(3)} * 15.0);
        float band = floor(uv.y * 30.0);
        float r = rand(vec2(band, t));
        float shift = (r - 0.5) * ${amount.toFixed(3)};
        if (r > 0.7) uv.x = fract(uv.x + shift);
        vec4 col = texture2D(u_texture, uv);
        float rC = texture2D(u_texture, uv + vec2(shift * 0.3, 0.0)).r;
        float bC = texture2D(u_texture, uv - vec2(shift * 0.3, 0.0)).b;
        gl_FragColor = vec4(rC, col.g, bC, col.a);
      }
    `,
    kaleidoscope: (segments, time) => `
      precision mediump float;
      uniform sampler2D u_texture;
      varying vec2 v_texCoord;
      #define PI 3.14159265358979
      void main() {
        vec2 uv = v_texCoord - 0.5;
        float angle = atan(uv.y, uv.x) + ${time.toFixed(3)} * 0.5;
        float radius = length(uv);
        float seg = PI * 2.0 / float(${Math.round(segments)});
        angle = mod(angle, seg);
        if (angle > seg * 0.5) angle = seg - angle;
        vec2 newUV = vec2(cos(angle), sin(angle)) * radius + 0.5;
        gl_FragColor = texture2D(u_texture, newUV);
      }
    `,
    chromaticAberration: (amount, angle) => `
      precision mediump float;
      uniform sampler2D u_texture;
      varying vec2 v_texCoord;
      void main() {
        float amt = ${amount.toFixed(4)};
        float ang = ${angle.toFixed(3)};
        vec2 dir = vec2(cos(ang), sin(ang)) * amt;
        float r = texture2D(u_texture, v_texCoord + dir).r;
        float g = texture2D(u_texture, v_texCoord).g;
        float b = texture2D(u_texture, v_texCoord - dir).b;
        float a = texture2D(u_texture, v_texCoord).a;
        gl_FragColor = vec4(r, g, b, a);
      }
    `,
    waveWarp: (amplitudeX, amplitudeY, frequencyX, frequencyY, speed, time) => `
      precision mediump float;
      uniform sampler2D u_texture;
      varying vec2 v_texCoord;
      void main() {
        float t = ${time.toFixed(3)} * ${speed.toFixed(3)};
        vec2 uv = v_texCoord;
        uv.x += sin(uv.y * ${frequencyX.toFixed(3)} * 6.2831 + t) * ${amplitudeX.toFixed(4)};
        uv.y += sin(uv.x * ${frequencyY.toFixed(3)} * 6.2831 + t) * ${amplitudeY.toFixed(4)};
        gl_FragColor = texture2D(u_texture, uv);
      }
    `,
    swirl: (strength, radius, centerX, centerY) => `
      precision mediump float;
      uniform sampler2D u_texture;
      varying vec2 v_texCoord;
      void main() {
        vec2 center = vec2(${centerX.toFixed(3)}, ${centerY.toFixed(3)});
        vec2 uv = v_texCoord - center;
        float dist = length(uv);
        float angle = ${strength.toFixed(3)} * max(0.0, ${radius.toFixed(3)} - dist) / ${radius.toFixed(3)};
        float s = sin(angle), c = cos(angle);
        uv = vec2(c * uv.x - s * uv.y, s * uv.x + c * uv.y);
        gl_FragColor = texture2D(u_texture, uv + center);
      }
    `,
    motionTile: (tilesX, tilesY, offsetX, offsetY, time) => `
      precision mediump float;
      uniform sampler2D u_texture;
      varying vec2 v_texCoord;
      void main() {
        float tx = ${tilesX.toFixed(3)}, ty = ${tilesY.toFixed(3)};
        float ox = ${offsetX.toFixed(3)} * ${time.toFixed(3)};
        float oy = ${offsetY.toFixed(3)} * ${time.toFixed(3)};
        vec2 uv = fract(v_texCoord * vec2(tx, ty) + vec2(ox, oy));
        gl_FragColor = texture2D(u_texture, uv);
      }
    `,
    colorBalance: (shadowsR, shadowsG, shadowsB, midsR, midsG, midsB, highlightsR, highlightsG, highlightsB) => `
      precision mediump float;
      uniform sampler2D u_texture;
      varying vec2 v_texCoord;
      void main() {
        vec4 c = texture2D(u_texture, v_texCoord);
        float lum = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
        float shadow = clamp(1.0 - lum * 2.0, 0.0, 1.0);
        float highlight = clamp(lum * 2.0 - 1.0, 0.0, 1.0);
        float mid = 1.0 - shadow - highlight;
        vec3 sh = vec3(${shadowsR.toFixed(3)}, ${shadowsG.toFixed(3)}, ${shadowsB.toFixed(3)});
        vec3 mi = vec3(${midsR.toFixed(3)}, ${midsG.toFixed(3)}, ${midsB.toFixed(3)});
        vec3 hi = vec3(${highlightsR.toFixed(3)}, ${highlightsG.toFixed(3)}, ${highlightsB.toFixed(3)});
        c.rgb += shadow * sh + mid * mi + highlight * hi;
        c.rgb = clamp(c.rgb, 0.0, 1.0);
        gl_FragColor = c;
      }
    `,
    hueSaturation: (hueShift, saturation, lightness) => `
      precision mediump float;
      uniform sampler2D u_texture;
      varying vec2 v_texCoord;
      vec3 rgb2hsl(vec3 c) {
        float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b));
        float h, s, l = (mx + mn) / 2.0;
        if (mx == mn) { h = s = 0.0; }
        else {
          float d = mx - mn;
          s = l > 0.5 ? d / (2.0 - mx - mn) : d / (mx + mn);
          if (mx == c.r) h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
          else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
          else h = (c.r - c.g) / d + 4.0;
          h /= 6.0;
        }
        return vec3(h, s, l);
      }
      float hue2rgb(float p, float q, float t) {
        if (t < 0.0) t += 1.0; if (t > 1.0) t -= 1.0;
        if (t < 1.0/6.0) return p + (q-p)*6.0*t;
        if (t < 1.0/2.0) return q;
        if (t < 2.0/3.0) return p + (q-p)*(2.0/3.0-t)*6.0;
        return p;
      }
      vec3 hsl2rgb(vec3 c) {
        if (c.y == 0.0) return vec3(c.z);
        float q = c.z < 0.5 ? c.z*(1.0+c.y) : c.z+c.y-c.z*c.y;
        float p = 2.0*c.z - q;
        return vec3(hue2rgb(p,q,c.x+1.0/3.0), hue2rgb(p,q,c.x), hue2rgb(p,q,c.x-1.0/3.0));
      }
      void main() {
        vec4 col = texture2D(u_texture, v_texCoord);
        vec3 hsl = rgb2hsl(col.rgb);
        hsl.x = fract(hsl.x + ${hueShift.toFixed(3)});
        hsl.y = clamp(hsl.y * ${saturation.toFixed(3)}, 0.0, 1.0);
        hsl.z = clamp(hsl.z + ${lightness.toFixed(3)}, 0.0, 1.0);
        col.rgb = hsl2rgb(hsl);
        gl_FragColor = col;
      }
    `,
    invert: (amount) => `
      precision mediump float;
      uniform sampler2D u_texture;
      varying vec2 v_texCoord;
      void main() {
        vec4 c = texture2D(u_texture, v_texCoord);
        c.rgb = mix(c.rgb, 1.0 - c.rgb, ${amount.toFixed(3)});
        gl_FragColor = c;
      }
    `,
    bloom: (threshold, intensity, radius) => `
      precision mediump float;
      uniform sampler2D u_texture;
      varying vec2 v_texCoord;
      void main() {
        vec4 color = texture2D(u_texture, v_texCoord);
        float lum = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
        vec3 glow = vec3(0.0);
        float r = ${radius.toFixed(4)};
        float samples = 0.0;
        for (int x = -3; x <= 3; x++) {
          for (int y = -3; y <= 3; y++) {
            vec2 offset = vec2(float(x), float(y)) * r;
            vec4 s = texture2D(u_texture, v_texCoord + offset);
            float sl = dot(s.rgb, vec3(0.2126, 0.7152, 0.0722));
            if (sl > ${threshold.toFixed(3)}) { glow += s.rgb; samples += 1.0; }
          }
        }
        if (samples > 0.0) glow /= samples;
        color.rgb += glow * ${intensity.toFixed(3)};
        gl_FragColor = clamp(color, 0.0, 1.0);
      }
    `,
    vignette: (strength, radius, softness) => `
      precision mediump float;
      uniform sampler2D u_texture;
      varying vec2 v_texCoord;
      void main() {
        vec4 color = texture2D(u_texture, v_texCoord);
        vec2 uv = v_texCoord - 0.5;
        float dist = length(uv);
        float vign = smoothstep(${radius.toFixed(3)}, ${radius.toFixed(3)} - ${softness.toFixed(3)}, dist);
        color.rgb *= mix(1.0 - ${strength.toFixed(3)}, 1.0, vign);
        gl_FragColor = color;
      }
    `,
    channelMixer: (rr, rg, rb, gr, gg, gb, br, bg, bb) => `
      precision mediump float;
      uniform sampler2D u_texture;
      varying vec2 v_texCoord;
      void main() {
        vec4 c = texture2D(u_texture, v_texCoord);
        float r = c.r*${rr.toFixed(3)} + c.g*${rg.toFixed(3)} + c.b*${rb.toFixed(3)};
        float g = c.r*${gr.toFixed(3)} + c.g*${gg.toFixed(3)} + c.b*${gb.toFixed(3)};
        float b = c.r*${br.toFixed(3)} + c.g*${bg.toFixed(3)} + c.b*${bb.toFixed(3)};
        gl_FragColor = vec4(clamp(vec3(r,g,b),0.0,1.0), c.a);
      }
    `,
    exposure: (stops) => `
      precision mediump float;
      uniform sampler2D u_texture;
      varying vec2 v_texCoord;
      void main() {
        vec4 c = texture2D(u_texture, v_texCoord);
        c.rgb *= pow(2.0, ${stops.toFixed(3)});
        c.rgb = clamp(c.rgb, 0.0, 1.0);
        gl_FragColor = c;
      }
    `
  };

  function applyWebGLEffect(imageElement, fragSrc) {
    const offCanvas = document.createElement("canvas");
    offCanvas.width = imageElement.naturalWidth || imageElement.videoWidth || imageElement.width;
    offCanvas.height = imageElement.naturalHeight || imageElement.videoHeight || imageElement.height;
    const offGl = offCanvas.getContext("webgl") || offCanvas.getContext("webgl2");
    if (!offGl) return imageElement;
    const prog = createShaderProgramForContext(offGl, BASE_VERT, fragSrc);
    offGl.useProgram(prog);
    const positionBuffer = offGl.createBuffer();
    offGl.bindBuffer(offGl.ARRAY_BUFFER, positionBuffer);
    offGl.bufferData(offGl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]), offGl.STATIC_DRAW);
    const texCoordBuffer = offGl.createBuffer();
    offGl.bindBuffer(offGl.ARRAY_BUFFER, texCoordBuffer);
    offGl.bufferData(offGl.ARRAY_BUFFER, new Float32Array([0,1,1,1,0,0,0,0,1,1,1,0]), offGl.STATIC_DRAW);
    const posLoc = offGl.getAttribLocation(prog, "a_position");
    const texLoc = offGl.getAttribLocation(prog, "a_texCoord");
    offGl.bindBuffer(offGl.ARRAY_BUFFER, positionBuffer);
    offGl.enableVertexAttribArray(posLoc);
    offGl.vertexAttribPointer(posLoc, 2, offGl.FLOAT, false, 0, 0);
    offGl.bindBuffer(offGl.ARRAY_BUFFER, texCoordBuffer);
    offGl.enableVertexAttribArray(texLoc);
    offGl.vertexAttribPointer(texLoc, 2, offGl.FLOAT, false, 0, 0);
    const texture = offGl.createTexture();
    offGl.bindTexture(offGl.TEXTURE_2D, texture);
    offGl.texParameteri(offGl.TEXTURE_2D, offGl.TEXTURE_WRAP_S, offGl.CLAMP_TO_EDGE);
    offGl.texParameteri(offGl.TEXTURE_2D, offGl.TEXTURE_WRAP_T, offGl.CLAMP_TO_EDGE);
    offGl.texParameteri(offGl.TEXTURE_2D, offGl.TEXTURE_MIN_FILTER, offGl.LINEAR);
    offGl.texImage2D(offGl.TEXTURE_2D, 0, offGl.RGBA, offGl.RGBA, offGl.UNSIGNED_BYTE, imageElement);
    offGl.viewport(0, 0, offCanvas.width, offCanvas.height);
    offGl.drawArrays(offGl.TRIANGLES, 0, 6);
    return offCanvas;
  }

  function createShaderProgramForContext(g, vertSrc, fragSrc) {
    const vert = g.createShader(g.VERTEX_SHADER);
    g.shaderSource(vert, vertSrc);
    g.compileShader(vert);
    const frag = g.createShader(g.FRAGMENT_SHADER);
    g.shaderSource(frag, fragSrc);
    g.compileShader(frag);
    const prog = g.createProgram();
    g.attachShader(prog, vert);
    g.attachShader(prog, frag);
    g.linkProgram(prog);
    return prog;
  }

  function effects(layerId) {
    const layer = layers.find(l => l.id === layerId);
    if (!layer) return null;
    const time = currentFrame / fps;

    return {
      tint(r = 1, g = 0.5, b = 0.5, amount = 0.5) {
        layer.effects.push({ type: "tint", params: { r, g, b, amount } });
        return this;
      },
      tzatzikiLens(strength = 0.5, centerX = 0.5, centerY = 0.5) {
        layer.effects.push({ type: "tzatzikiLens", params: { strength, centerX, centerY } });
        return this;
      },
      turbulentDisplace(scale = 3, intensity = 0.05, time = 0) {
        layer.effects.push({ type: "turbulentDisplace", params: { scale, intensity, time } });
        return this;
      },
      wiggle(amountX = 0.02, amountY = 0.02, speed = 1, time = 0) {
        layer.effects.push({ type: "wiggle", params: { amountX, amountY, speed, time } });
        return this;
      },
      noise(intensity = 0.1, scale = 1, time = 0) {
        layer.effects.push({ type: "noise", params: { intensity, scale, time } });
        return this;
      },
      meshGlitch(amount = 0.1, time = 0) {
        layer.effects.push({ type: "meshGlitch", params: { amount, time } });
        return this;
      },
      glitch(amount = 0.1, time = 0) {
        layer.effects.push({ type: "glitch", params: { amount, time } });
        return this;
      },
      kaleidoscope(segments = 6, time = 0) {
        layer.effects.push({ type: "kaleidoscope", params: { segments, time } });
        return this;
      },
      chromaticAberration(amount = 0.005, angle = 0) {
        layer.effects.push({ type: "chromaticAberration", params: { amount, angle } });
        return this;
      },
      waveWarp(amplitudeX = 0.02, amplitudeY = 0.02, frequencyX = 2, frequencyY = 2, speed = 1, time = 0) {
        layer.effects.push({ type: "waveWarp", params: { amplitudeX, amplitudeY, frequencyX, frequencyY, speed, time } });
        return this;
      },
      swirl(strength = 3, radius = 0.4, centerX = 0.5, centerY = 0.5) {
        layer.effects.push({ type: "swirl", params: { strength, radius, centerX, centerY } });
        return this;
      },
      motionTile(tilesX = 2, tilesY = 2, offsetX = 0.1, offsetY = 0.1, time = 0) {
        layer.effects.push({ type: "motionTile", params: { tilesX, tilesY, offsetX, offsetY, time } });
        return this;
      },
      typewriter(text = "", charIndex = 0, fontFamily = "monospace", fontSize = 32, color = "#fff", x = 50, y = 50) {
        layer.effects.push({ type: "typewriter", params: { text, charIndex, fontFamily, fontSize, color, x, y } });
        return this;
      },
      colorBalance(shadowsR = 0, shadowsG = 0, shadowsB = 0, midsR = 0, midsG = 0, midsB = 0, highlightsR = 0, highlightsG = 0, highlightsB = 0) {
        layer.effects.push({ type: "colorBalance", params: { shadowsR, shadowsG, shadowsB, midsR, midsG, midsB, highlightsR, highlightsG, highlightsB } });
        return this;
      },
      hueSaturation(hueShift = 0, saturation = 1, lightness = 0) {
        layer.effects.push({ type: "hueSaturation", params: { hueShift, saturation, lightness } });
        return this;
      },
      invert(amount = 1) {
        layer.effects.push({ type: "invert", params: { amount } });
        return this;
      },
      bloom(threshold = 0.7, intensity = 0.5, radius = 0.002) {
        layer.effects.push({ type: "bloom", params: { threshold, intensity, radius } });
        return this;
      },
      vignette(strength = 0.5, radius = 0.5, softness = 0.3) {
        layer.effects.push({ type: "vignette", params: { strength, radius, softness } });
        return this;
      },
      channelMixer(rr = 1, rg = 0, rb = 0, gr = 0, gg = 1, gb = 0, br = 0, bg = 0, bb = 1) {
        layer.effects.push({ type: "channelMixer", params: { rr, rg, rb, gr, gg, gb, br, bg, bb } });
        return this;
      },
      exposure(stops = 0) {
        layer.effects.push({ type: "exposure", params: { stops } });
        return this;
      },
      clear() {
        layer.effects = [];
        return this;
      }
    };
  }

  function getFragSrc(effect, t) {
    const p = effect.params;
    const time = t !== undefined ? t : p.time || 0;
    switch (effect.type) {
      case "tint": return shaders.tint(p.r, p.g, p.b, p.amount);
      case "tzatzikiLens": return shaders.tzatzikiLens(p.strength, p.centerX, p.centerY);
      case "turbulentDisplace": return shaders.turbulentDisplace(p.scale, p.intensity, time);
      case "wiggle": return shaders.wiggle(p.amountX, p.amountY, p.speed, time);
      case "noise": return shaders.noise(p.intensity, p.scale, time);
      case "meshGlitch": return shaders.meshGlitch(p.amount, time);
      case "glitch": return shaders.glitch(p.amount, time);
      case "kaleidoscope": return shaders.kaleidoscope(p.segments, time);
      case "chromaticAberration": return shaders.chromaticAberration(p.amount, p.angle);
      case "waveWarp": return shaders.waveWarp(p.amplitudeX, p.amplitudeY, p.frequencyX, p.frequencyY, p.speed, time);
      case "swirl": return shaders.swirl(p.strength, p.radius, p.centerX, p.centerY);
      case "motionTile": return shaders.motionTile(p.tilesX, p.tilesY, p.offsetX, p.offsetY, time);
      case "colorBalance": return shaders.colorBalance(p.shadowsR, p.shadowsG, p.shadowsB, p.midsR, p.midsG, p.midsB, p.highlightsR, p.highlightsG, p.highlightsB);
      case "hueSaturation": return shaders.hueSaturation(p.hueShift, p.saturation, p.lightness);
      case "invert": return shaders.invert(p.amount);
      case "bloom": return shaders.bloom(p.threshold, p.intensity, p.radius);
      case "vignette": return shaders.vignette(p.strength, p.radius, p.softness);
      case "channelMixer": return shaders.channelMixer(p.rr, p.rg, p.rb, p.gr, p.gg, p.gb, p.br, p.bg, p.bb);
      case "exposure": return shaders.exposure(p.stops);
      default: return null;
    }
  }

  function renderLayer(ctx, layer, frameTime) {
    ctx.save();
    ctx.globalAlpha = layer.opacity !== undefined ? layer.opacity : 1;
    const cx = layer.x + (layer.width || 0) / 2;
    const cy = layer.y + (layer.height || 0) / 2;
    ctx.translate(cx, cy);
    ctx.rotate((layer.rotation || 0) * Math.PI / 180);
    ctx.scale(layer.scaleX || 1, layer.scaleY || 1);
    ctx.translate(-cx, -cy);

    let source = layer.element;

    for (const eff of (layer.effects || [])) {
      if (eff.type === "typewriter") {
        const p = eff.params;
        ctx.font = `${p.fontSize}px ${p.fontFamily}`;
        ctx.fillStyle = p.color;
        const visible = p.text.substring(0, Math.floor(frameTime * 10));
        ctx.fillText(visible, p.x, p.y);
        continue;
      }
      const fragSrc = getFragSrc(eff, frameTime);
      if (fragSrc && source) {
        try { source = applyWebGLEffect(source, fragSrc); } catch (e) {}
      }
    }

    if (source && layer.type !== "text") {
      try {
        ctx.drawImage(source, layer.x, layer.y, layer.width || source.width, layer.height || source.height);
      } catch (e) {}
    }

    if (layer.type === "text") {
      ctx.font = `${layer.fontSize || 32}px ${layer.fontFamily || "sans-serif"}`;
      ctx.fillStyle = layer.color || "#fff";
      ctx.fillText(layer.text || "", layer.x, layer.y);
    }

    ctx.restore();
  }

  function renderFrame(outputCanvas, frame) {
    const ctx = outputCanvas.getContext("2d");
    const frameTime = frame / fps;
    ctx.clearRect(0, 0, outputCanvas.width, outputCanvas.height);
    const sortedLayers = [...layers].sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0));
    for (const layer of sortedLayers) {
      if (!layer.visible) continue;
      const inRange = (layer.startFrame === undefined || frame >= layer.startFrame) &&
                      (layer.endFrame === undefined || frame <= layer.endFrame);
      if (!inRange) continue;
      renderLayer(ctx, layer, frameTime);
    }
  }

  function unlimitedLayers() {
    return {
      add(config = {}) {
        const layer = {
          id: `layer_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          name: config.name || `Layer ${layers.length + 1}`,
          type: config.type || "image",
          element: config.element || null,
          x: config.x || 0,
          y: config.y || 0,
          width: config.width || 0,
          height: config.height || 0,
          rotation: config.rotation || 0,
          scaleX: config.scaleX || 1,
          scaleY: config.scaleY || 1,
          opacity: config.opacity !== undefined ? config.opacity : 1,
          visible: config.visible !== false,
          zIndex: config.zIndex || layers.length,
          effects: [],
          startFrame: config.startFrame || 0,
          endFrame: config.endFrame !== undefined ? config.endFrame : totalFrames,
          text: config.text || "",
          fontFamily: config.fontFamily || "sans-serif",
          fontSize: config.fontSize || 32,
          color: config.color || "#ffffff"
        };
        layers.push(layer);
        selectedLayer = layer;
        return layer;
      },
      remove(id) {
        const idx = layers.findIndex(l => l.id === id);
        if (idx !== -1) layers.splice(idx, 1);
      },
      get(id) { return layers.find(l => l.id === id); },
      getAll() { return [...layers]; },
      reorder(id, newZIndex) {
        const layer = layers.find(l => l.id === id);
        if (layer) layer.zIndex = newZIndex;
      },
      duplicate(id) {
        const layer = layers.find(l => l.id === id);
        if (!layer) return null;
        const copy = JSON.parse(JSON.stringify(layer));
        copy.id = `layer_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        copy.name = layer.name + " Copy";
        copy.zIndex = layers.length;
        copy.effects = layer.effects.map(e => ({ ...e, params: { ...e.params } }));
        copy.element = layer.element;
        layers.push(copy);
        return copy;
      },
      select(id) {
        selectedLayer = layers.find(l => l.id === id) || null;
        return selectedLayer;
      },
      getSelected() { return selectedLayer; }
    };
  }

  function unlimitedTracks() {
    return {
      add(config = {}) {
        const track = {
          id: `track_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          name: config.name || `Track ${tracks.length + 1}`,
          type: config.type || "video",
          layerIds: [],
          startFrame: config.startFrame || 0,
          endFrame: config.endFrame !== undefined ? config.endFrame : totalFrames,
          muted: false,
          locked: false,
          solo: false
        };
        tracks.push(track);
        return track;
      },
      remove(id) {
        const idx = tracks.findIndex(t => t.id === id);
        if (idx !== -1) tracks.splice(idx, 1);
      },
      get(id) { return tracks.find(t => t.id === id); },
      getAll() { return [...tracks]; },
      addLayerToTrack(trackId, layerId) {
        const track = tracks.find(t => t.id === trackId);
        if (track && !track.layerIds.includes(layerId)) track.layerIds.push(layerId);
      },
      removeLayerFromTrack(trackId, layerId) {
        const track = tracks.find(t => t.id === trackId);
        if (track) track.layerIds = track.layerIds.filter(id => id !== layerId);
      },
      mute(id, state = true) {
        const track = tracks.find(t => t.id === id);
        if (track) {
          track.muted = state;
          track.layerIds.forEach(lid => {
            const l = layers.find(l => l.id === lid);
            if (l) l.visible = !state;
          });
        }
      },
      solo(id) {
        tracks.forEach(t => t.solo = false);
        const track = tracks.find(t => t.id === id);
        if (track) {
          track.solo = true;
          layers.forEach(l => l.visible = track.layerIds.includes(l.id));
        }
      },
      lock(id, state = true) {
        const track = tracks.find(t => t.id === id);
        if (track) track.locked = state;
      }
    };
  }

  function rotate(layerId, degrees, options = {}) {
    const layer = layers.find(l => l.id === layerId);
    if (!layer) return;
    if (options.animate) {
      const startFrame = options.startFrame || currentFrame;
      const endFrame = options.endFrame || (startFrame + (options.duration || 30) * fps);
      const startRot = layer.rotation;
      layer.keyframes = layer.keyframes || [];
      layer.keyframes.push({ property: "rotation", startFrame, endFrame, from: startRot, to: degrees });
    } else {
      layer.rotation = degrees;
    }
  }

  function scale(layerId, scaleX, scaleY, options = {}) {
    const layer = layers.find(l => l.id === layerId);
    if (!layer) return;
    if (options.animate) {
      const startFrame = options.startFrame || currentFrame;
      const endFrame = options.endFrame || (startFrame + (options.duration || 30) * fps);
      layer.keyframes = layer.keyframes || [];
      layer.keyframes.push({ property: "scaleX", startFrame, endFrame, from: layer.scaleX, to: scaleX });
      layer.keyframes.push({ property: "scaleY", startFrame, endFrame, from: layer.scaleY, to: scaleY });
    } else {
      layer.scaleX = scaleX;
      layer.scaleY = scaleY;
    }
  }

  function positionXandY(layerId, x, y, options = {}) {
    const layer = layers.find(l => l.id === layerId);
    if (!layer) return;
    if (options.animate) {
      const startFrame = options.startFrame || currentFrame;
      const endFrame = options.endFrame || (startFrame + (options.duration || 30) * fps);
      layer.keyframes = layer.keyframes || [];
      layer.keyframes.push({ property: "x", startFrame, endFrame, from: layer.x, to: x });
      layer.keyframes.push({ property: "y", startFrame, endFrame, from: layer.y, to: y });
    } else {
      layer.x = x;
      layer.y = y;
    }
  }

  function applyKeyframes(layer, frame) {
    if (!layer.keyframes) return;
    for (const kf of layer.keyframes) {
      if (frame >= kf.startFrame && frame <= kf.endFrame) {
        const t = (frame - kf.startFrame) / (kf.endFrame - kf.startFrame);
        const eased = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
        layer[kf.property] = kf.from + (kf.to - kf.from) * eased;
      }
    }
  }

  function uploadVideoAndImage() {
    return {
      fromFile(file) {
        return new Promise((resolve, reject) => {
          const url = URL.createObjectURL(file);
          const isVideo = file.type.startsWith("video/");
          if (isVideo) {
            const video = document.createElement("video");
            video.src = url;
            video.crossOrigin = "anonymous";
            video.muted = true;
            video.preload = "metadata";
            video.onloadeddata = () => resolve({ element: video, type: "video", url, width: video.videoWidth, height: video.videoHeight });
            video.onerror = reject;
          } else {
            const img = new Image();
            img.src = url;
            img.crossOrigin = "anonymous";
            img.onload = () => resolve({ element: img, type: "image", url, width: img.naturalWidth, height: img.naturalHeight });
            img.onerror = reject;
          }
        });
      },
      fromURL(url) {
        return new Promise((resolve, reject) => {
          const isVideo = /\.(mp4|webm|ogg|mov)(\?|$)/i.test(url);
          if (isVideo) {
            const video = document.createElement("video");
            video.src = url;
            video.crossOrigin = "anonymous";
            video.muted = true;
            video.preload = "metadata";
            video.onloadeddata = () => resolve({ element: video, type: "video", url, width: video.videoWidth, height: video.videoHeight });
            video.onerror = reject;
          } else {
            const img = new Image();
            img.crossOrigin = "anonymous";
            img.src = url;
            img.onload = () => resolve({ element: img, type: "image", url, width: img.naturalWidth, height: img.naturalHeight });
            img.onerror = reject;
          }
        });
      },
      createInputButton(container, onLoaded) {
        const btn = document.createElement("input");
        btn.type = "file";
        btn.accept = "image/*,video/*";
        btn.multiple = true;
        btn.style.display = "none";
        btn.onchange = async (e) => {
          for (const file of e.target.files) {
            const result = await this.fromFile(file);
            onLoaded(result);
          }
        };
        container.appendChild(btn);
        return btn;
      }
    };
  }

  function addAndRemoveText() {
    return {
      add(config = {}) {
        const layerApi = unlimitedLayers();
        const layer = layerApi.add({
          type: "text",
          name: config.name || "Text Layer",
          text: config.text || "Text",
          x: config.x || 100,
          y: config.y || 100,
          fontFamily: config.fontFamily || "sans-serif",
          fontSize: config.fontSize || 32,
          color: config.color || "#ffffff",
          startFrame: config.startFrame,
          endFrame: config.endFrame
        });
        return layer;
      },
      remove(layerId) {
        const idx = layers.findIndex(l => l.id === layerId);
        if (idx !== -1) layers.splice(idx, 1);
      },
      update(layerId, props = {}) {
        const layer = layers.find(l => l.id === layerId);
        if (!layer) return;
        if (props.text !== undefined) layer.text = props.text;
        if (props.fontFamily !== undefined) layer.fontFamily = props.fontFamily;
        if (props.fontSize !== undefined) layer.fontSize = props.fontSize;
        if (props.color !== undefined) layer.color = props.color;
        if (props.x !== undefined) layer.x = props.x;
        if (props.y !== undefined) layer.y = props.y;
      },
      getAll() { return layers.filter(l => l.type === "text"); }
    };
  }

  const GOOGLE_FONTS = [
    "Roboto", "Open Sans", "Lato", "Montserrat", "Oswald", "Raleway",
    "Playfair Display", "Merriweather", "Nunito", "Ubuntu", "Poppins",
    "Source Code Pro", "Bebas Neue", "Anton", "Cinzel", "Lobster",
    "Pacifico", "Dancing Script", "Josefin Sans", "Barlow Condensed",
    "Space Mono", "Inconsolata", "DM Serif Display", "Fraunces",
    "Syne", "Cabinet Grotesk", "Clash Display", "Satoshi", "General Sans"
  ];

  function fonts() {
    return {
      list() { return [...GOOGLE_FONTS]; },
      load(fontFamily) {
        return new Promise((resolve) => {
          const link = document.createElement("link");
          link.rel = "stylesheet";
          link.href = `https://fonts.googleapis.com/css2?family=${fontFamily.replace(/ /g, "+")}:wght@300;400;700;900&display=swap`;
          link.onload = () => resolve(fontFamily);
          document.head.appendChild(link);
        });
      },
      loadMultiple(fontFamilies) {
        return Promise.all(fontFamilies.map(f => this.load(f)));
      },
      apply(layerId, fontFamily, fontSize) {
        const layer = layers.find(l => l.id === layerId);
        if (!layer) return;
        this.load(fontFamily).then(() => {
          layer.fontFamily = fontFamily;
          if (fontSize) layer.fontSize = fontSize;
        });
      },
      systemFonts: ["Arial", "Helvetica", "Georgia", "Times New Roman", "Courier New", "Verdana", "Impact", "Comic Sans MS"]
    };
  }

  async function exportImageAndVideo(outputCanvas, options = {}) {
    const {
      format = "image",
      filename = "export",
      quality = 0.92,
      mediabunnyKey = MEDIABUNNY_KEY,
      fps: exportFps = fps,
      startFrame: sf = 0,
      endFrame: ef = totalFrames,
      width = outputCanvas.width,
      height = outputCanvas.height,
      uploadToCloud = false
    } = options;

    if (format === "image") {
      const mimeType = options.imageFormat === "png" ? "image/png" : "image/jpeg";
      const ext = options.imageFormat === "png" ? "png" : "jpg";
      renderFrame(outputCanvas, currentFrame);
      return new Promise((resolve) => {
        outputCanvas.toBlob((blob) => {
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `${filename}.${ext}`;
          a.click();
          URL.revokeObjectURL(url);
          if (uploadToCloud && mediabunnyKey) {
            uploadToMediabunny(blob, `${filename}.${ext}`, mediabunnyKey).then(resolve);
          } else {
            resolve({ blob, url: null });
          }
        }, mimeType, quality);
      });
    }

    if (format === "video") {
      const offCanvas = document.createElement("canvas");
      offCanvas.width = width;
      offCanvas.height = height;
      const stream = offCanvas.captureStream(exportFps);
      const recorder = new MediaRecorder(stream, {
        mimeType: "video/webm;codecs=vp9",
        videoBitsPerSecond: 8000000
      });
      const chunks = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };

      return new Promise((resolve) => {
        recorder.onstop = async () => {
          const blob = new Blob(chunks, { type: "video/webm" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `${filename}.webm`;
          a.click();
          URL.revokeObjectURL(url);
          if (uploadToCloud && mediabunnyKey) {
            const result = await uploadToMediabunny(blob, `${filename}.webm`, mediabunnyKey);
            resolve(result);
          } else {
            resolve({ blob, url: null });
          }
        };

        recorder.start();
        let frame = sf;
        const frameInterval = 1000 / exportFps;
        function renderNext() {
          if (frame > ef) {
            recorder.stop();
            return;
          }
          renderFrame(offCanvas, frame);
          frame++;
          setTimeout(renderNext, frameInterval);
        }
        renderNext();
      });
    }
  }

  async function uploadToMediabunny(blob, filename, apiKey) {
    try {
      const formData = new FormData();
      formData.append("file", blob, filename);
      const uploadRes = await fetch(`${MEDIABUNNY_API}/upload`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${apiKey}` },
        body: formData
      });
      const uploadData = await uploadRes.json();
      const assetId = uploadData.asset_id || uploadData.id;
      let jobId = null;
      if (filename.endsWith(".webm")) {
        const convertRes = await fetch(`${MEDIABUNNY_API}/jobs`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            asset_id: assetId,
            output_format: "mp4",
            video_codec: "h264",
            audio_codec: "aac"
          })
        });
        const convertData = await convertRes.json();
        jobId = convertData.job_id || convertData.id;
        const downloadUrl = await pollMediabunnyJob(apiKey, jobId);
        return { assetId, jobId, downloadUrl };
      }
      return { assetId, downloadUrl: uploadData.url };
    } catch (err) {
      console.error("Mediabunny upload error:", err);
      return { error: err.message };
    }
  }

  async function pollMediabunnyJob(apiKey, jobId, maxAttempts = 60, intervalMs = 2000) {
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(r => setTimeout(r, intervalMs));
      const res = await fetch(`${MEDIABUNNY_API}/jobs/${jobId}`, {
        headers: { "Authorization": `Bearer ${apiKey}` }
      });
      const data = await res.json();
      if (data.status === "completed" || data.status === "done") return data.output_url || data.download_url;
      if (data.status === "failed") throw new Error("Mediabunny job failed");
    }
    throw new Error("Mediabunny job timed out");
  }

  function UI(containerEl, outputCanvas) {
    if (!containerEl || !outputCanvas) return;
    uiRoot = document.createElement("div");
    uiRoot.className = "studio-ui";
    uiRoot.style.cssText = "position:relative;display:flex;flex-direction:column;gap:8px;padding:12px;background:#1a1a1a;color:#fff;font-family:sans-serif;font-size:13px;";

    const toolbar = document.createElement("div");
    toolbar.style.cssText = "display:flex;align-items:center;gap:8px;flex-wrap:wrap;";

    const playBtn = document.createElement("button");
    playBtn.textContent = "▶ Play";
    playBtn.style.cssText = "padding:6px 14px;background:#3a86ff;color:#fff;border:none;border-radius:4px;cursor:pointer;";
    playBtn.onclick = () => {
      if (isPlaying) {
        isPlaying = false;
        cancelAnimationFrame(animationId);
        playBtn.textContent = "▶ Play";
      } else {
        isPlaying = true;
        playBtn.textContent = "⏸ Pause";
        function loop() {
          if (!isPlaying) return;
          currentFrame = (currentFrame + 1) % totalFrames;
          renderFrame(outputCanvas, currentFrame);
          scrubber.value = currentFrame;
          animationId = requestAnimationFrame(loop);
        }
        loop();
      }
    };

    const stopBtn = document.createElement("button");
    stopBtn.textContent = "⏹";
    stopBtn.style.cssText = "padding:6px 10px;background:#444;color:#fff;border:none;border-radius:4px;cursor:pointer;";
    stopBtn.onclick = () => {
      isPlaying = false;
      cancelAnimationFrame(animationId);
      currentFrame = 0;
      renderFrame(outputCanvas, 0);
      scrubber.value = 0;
      playBtn.textContent = "▶ Play";
    };

    const frameLabel = document.createElement("span");
    frameLabel.textContent = `Frame: 0 / ${totalFrames}`;
    frameLabel.style.cssText = "min-width:120px;color:#aaa;";

    const scrubber = document.createElement("input");
    scrubber.type = "range";
    scrubber.min = 0;
    scrubber.max = totalFrames;
    scrubber.value = 0;
    scrubber.style.cssText = "flex:1;min-width:200px;";
    scrubber.oninput = () => {
      currentFrame = parseInt(scrubber.value);
      frameLabel.textContent = `Frame: ${currentFrame} / ${totalFrames}`;
      renderFrame(outputCanvas, currentFrame);
    };

    toolbar.append(playBtn, stopBtn, scrubber, frameLabel);
    uiRoot.appendChild(toolbar);
    containerEl.appendChild(uiRoot);

    return {
      addSection(title, content) {
        const sec = document.createElement("details");
        sec.open = true;
        sec.style.cssText = "border:1px solid #333;border-radius:4px;padding:8px;";
        const sum = document.createElement("summary");
        sum.textContent = title;
        sum.style.cssText = "cursor:pointer;font-weight:bold;color:#aef;";
        sec.appendChild(sum);
        sec.appendChild(content);
        uiRoot.appendChild(sec);
        return sec;
      },
      getRoot() { return uiRoot; }
    };
  }

  function UImenu(containerEl, items = []) {
    const menu = document.createElement("div");
    menu.style.cssText = "display:flex;gap:0;background:#111;border-bottom:1px solid #333;";
    for (const item of items) {
      const btn = document.createElement("div");
      btn.style.cssText = "position:relative;";
      const label = document.createElement("button");
      label.textContent = item.label;
      label.style.cssText = "padding:8px 14px;background:transparent;color:#ccc;border:none;cursor:pointer;font-size:13px;";
      label.onmouseover = () => { label.style.color = "#fff"; label.style.background = "#222"; };
      label.onmouseout = () => { label.style.color = "#ccc"; label.style.background = "transparent"; };
      btn.appendChild(label);
      if (item.children && item.children.length) {
        const dropdown = document.createElement("div");
        dropdown.style.cssText = "display:none;position:absolute;top:100%;left:0;background:#222;border:1px solid #444;z-index:9999;min-width:160px;";
        for (const child of item.children) {
          const opt = document.createElement("div");
          opt.textContent = child.label;
          opt.style.cssText = "padding:8px 14px;cursor:pointer;color:#ccc;font-size:13px;";
          opt.onmouseover = () => { opt.style.background = "#333"; opt.style.color = "#fff"; };
          opt.onmouseout = () => { opt.style.background = "transparent"; opt.style.color = "#ccc"; };
          opt.onclick = () => { if (child.action) child.action(); dropdown.style.display = "none"; };
          dropdown.appendChild(opt);
        }
        label.onclick = () => { dropdown.style.display = dropdown.style.display === "none" ? "block" : "none"; };
        document.addEventListener("click", (e) => { if (!btn.contains(e.target)) dropdown.style.display = "none"; });
        btn.appendChild(dropdown);
      } else {
        label.onclick = () => { if (item.action) item.action(); };
      }
      menu.appendChild(btn);
    }
    containerEl.appendChild(menu);
    return menu;
  }

  function slider(containerEl, options = {}) {
    const {
      label = "Value",
      min = 0,
      max = 1,
      step = 0.01,
      value = 0.5,
      onChange = () => {}
    } = options;

    const wrap = document.createElement("div");
    wrap.style.cssText = "display:flex;align-items:center;gap:8px;margin:4px 0;";

    const lbl = document.createElement("label");
    lbl.textContent = label;
    lbl.style.cssText = "min-width:130px;color:#ccc;font-size:12px;";

    const inp = document.createElement("input");
    inp.type = "range";
    inp.min = min;
    inp.max = max;
    inp.step = step;
    inp.value = value;
    inp.style.cssText = "flex:1;";

    const numDisplay = document.createElement("span");
    numDisplay.textContent = parseFloat(value).toFixed(2);
    numDisplay.style.cssText = "min-width:40px;color:#aaa;font-size:12px;text-align:right;";

    inp.oninput = () => {
      numDisplay.textContent = parseFloat(inp.value).toFixed(2);
      onChange(parseFloat(inp.value));
    };

    wrap.append(lbl, inp, numDisplay);
    containerEl.appendChild(wrap);

    return {
      el: wrap,
      getValue() { return parseFloat(inp.value); },
      setValue(v) { inp.value = v; numDisplay.textContent = parseFloat(v).toFixed(2); }
    };
  }

  function boolean(containerEl, options = {}) {
    const { label = "Toggle", value = false, onChange = () => {} } = options;

    const wrap = document.createElement("div");
    wrap.style.cssText = "display:flex;align-items:center;gap:10px;margin:4px 0;";

    const lbl = document.createElement("label");
    lbl.textContent = label;
    lbl.style.cssText = "color:#ccc;font-size:12px;cursor:pointer;";

    const toggle = document.createElement("div");
    toggle.style.cssText = `width:36px;height:20px;border-radius:10px;background:${value ? "#3a86ff" : "#555"};position:relative;cursor:pointer;transition:background 0.2s;`;

    const thumb = document.createElement("div");
    thumb.style.cssText = `width:16px;height:16px;border-radius:50%;background:#fff;position:absolute;top:2px;left:${value ? "18px" : "2px"};transition:left 0.2s;`;

    let current = value;
    toggle.appendChild(thumb);
    toggle.onclick = () => {
      current = !current;
      toggle.style.background = current ? "#3a86ff" : "#555";
      thumb.style.left = current ? "18px" : "2px";
      onChange(current);
    };
    lbl.onclick = toggle.onclick;

    wrap.append(toggle, lbl);
    containerEl.appendChild(wrap);

    return {
      el: wrap,
      getValue() { return current; },
      setValue(v) {
        current = v;
        toggle.style.background = current ? "#3a86ff" : "#555";
        thumb.style.left = current ? "18px" : "2px";
      }
    };
  }

  function color(containerEl, options = {}) {
    const { label = "Color", value = "#ffffff", onChange = () => {} } = options;

    const wrap = document.createElement("div");
    wrap.style.cssText = "display:flex;align-items:center;gap:8px;margin:4px 0;";

    const lbl = document.createElement("label");
    lbl.textContent = label;
    lbl.style.cssText = "min-width:130px;color:#ccc;font-size:12px;";

    const inp = document.createElement("input");
    inp.type = "color";
    inp.value = value;
    inp.style.cssText = "width:36px;height:24px;border:none;padding:0;cursor:pointer;background:none;border-radius:3px;";

    const hex = document.createElement("span");
    hex.textContent = value;
    hex.style.cssText = "color:#aaa;font-size:12px;font-family:monospace;";

    inp.oninput = () => {
      hex.textContent = inp.value;
      onChange(inp.value);
    };

    wrap.append(lbl, inp, hex);
    containerEl.appendChild(wrap);

    return {
      el: wrap,
      getValue() { return inp.value; },
      setValue(v) { inp.value = v; hex.textContent = v; }
    };
  }

  return {
    init(outputCanvas) {
      canvas = outputCanvas;
      ctx2d = canvas.getContext("2d");
      return this;
    },
    setTimeline(frames, frameRate) {
      totalFrames = frames;
      fps = frameRate;
    },
    getCurrentFrame() { return currentFrame; },
    setFrame(f) { currentFrame = f; },
    getFPS() { return fps; },
    layers: unlimitedLayers,
    tracks: unlimitedTracks,
    effects,
    rotate,
    scale,
    positionXandY,
    upload: uploadVideoAndImage,
    text: addAndRemoveText,
    fonts,
    export: exportImageAndVideo,
    render: renderFrame,
    UI,
    UImenu,
    slider,
    boolean,
    color,
    shaders,
    applyWebGLEffect,
    getFragSrc
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = Studio;
if (typeof window !== "undefined") window.Studio = Studio;
