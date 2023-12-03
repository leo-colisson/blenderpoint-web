import getVideoFrames from "./getVideoFrames.js/mod.js"

class BlenderpointVideoWorker {
  constructor(canvas, config) {
    config = config || {};
    this.canvas = canvas;
    this.ctx = this.canvas.getContext("2d");
    // We color it in all black
    this.ctx.fillStyle = "black";
    this.ctx.fill();
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.isLoadingVideo = false;
    // `frames` is a list of VideoFrame object: https://developer.mozilla.org/en-US/docs/Web/API/VideoFrame
    this.frames = [];
    this.total_nb_frames = 0; // this might not even be set if the video is not fully loaded.
    this.videoWidth = 0;
    this.videoHeight = 0;
    this.fps = 24;
    // This will help requestAnimationFrame
    this.currentFrame = 0;
    this.timeLastDraw = null;
    this.lastDrawnFrame = -1; // helpful to know if we need to redraw the frame or not.
    // playbackSpeed is the speed of playing: 0 means that it does not play, 1 it plays at normal speed forward,
    // -1 it plays at normal speed backward, 1.5 it plays at speed x1.5…
    this.playbackSpeed = 1;
    this.isPlayingUntil = undefined;
    this.isPlayingUntilPrevious = undefined;
    this.animationFrameID = null;
    // we might also call request animation frame if the user wants to display something on screen
    // while the video is not yet loaded, use this for that use case.
    this.animationFrameIDFetching = null;
    this.stops = []; // contains the list of stops
    this.jsonComments = {}; // contains the content of the json in the comments of the video
    this.alert = (m) => self.postMessage({alert: m});
    this.frameLog = (m) => console.log(m);
    // resize canvas when needed
    addEventListener("fullscreenchange", async (event) => {
      if (!document.fullscreenElement) {
        // we are quitting fullscreen mode
        this.canvas.width = this.origCanvasWidth;
        this.canvas.height = this.origCanvasHeight;
        // we redraw the canvas as the canvas is cleared.
        this.redrawWhenResolutionChanges();
      }
    });
  }

  updateAlertFunction (new_alert) {
    this.alert = new_alert;
  }
  
  // extracts the json from the video
  // must be in a meta field like comment, and enclosed between BLENDERPOINTSTART and BLENDERPOINTSTOP
  extractJsonFromVideo(mp4boxFile) {
    const metaBoxes = mp4boxFile.getBoxes("meta");
    const decoder = new TextDecoder('utf-8');
    var content = null;
    metaBoxes.forEach((metaBox) => {
      var str = decoder.decode(metaBox.data);
      // https://stackoverflow.com/questions/1979884/how-to-use-javascript-regex-over-multiple-lines
      // [\s\S] is for empty lines, *? is for the non-greedy search
      const matches = [...str.matchAll(/BLENDERPOINTSTART([\s\S]*?)BLENDERPOINTSTOP/g)];
      if (matches.length > 0) {
        content = matches[0][1];
      }
    });
    return content;
  }
  
  isPlaying() {
    console.log(this.animationFrameID);
    return this.animationFrameID != null;
  }

  setFps(fps) {
    this.fps = fps;
  }

  setStops(stops) {
    this.stops = stops;
  }

  getStops() {
    return this.stops;
  }

  setStopsFromString(stops) {
    this.stops = [...new Set(stops.split(",").map(e => parseInt(e)))].sort(function(a, b) {
      return a - b;
    });
  }

  // call it like:
  // <input type="file" accept="video/mp4" onchange="bpVideo.loadVideoFile(this.files[0])">
  // config might contain additional parameters, notably callbacks
  async loadVideoFileFromFile(file, config) {
    if (!config) {
      config = {};
    }
    console.log("File", file);
    let videoObjectURL = URL.createObjectURL(file);
    console.log("url", videoObjectURL);
    await this.loadVideoFileFromObjectURL(videoObjectURL, config);
    URL.revokeObjectURL(file); // revoke URL to prevent memory leak
  }

  // You can pass both object url, or normal url like https://leo-colisson.github.io/blenderpoint-web/Demo_24fps.mp4
  async loadVideoFileFromObjectURL(videoObjectURL, config) {
    if (!config) {
      config = {};
    }
    // turn to true when the stops are obtained
    this.isReady = false;
    this._ensureStoppedAnimationFrame();
    // We don’t know yet the number of frames
    this.total_nb_frames = 0;
    this.frames.forEach((frame) => frame.close());
    this.frames = [];
    this.currentFrame = 0;
    this.lastDrawnFrame = -1;
    // direction useful to play backward.
    this.playbackSpeed = 1;
    this.isLoadingVideo = true;
    console.log(videoObjectURL);
    const currentObject = this; // otherwise self is replaced with a new self value
    await getVideoFrames({
      videoUrl: videoObjectURL,
      onFrame(frame) {
        currentObject.frames.push(frame);
        // we print the first frame on screen
        if (currentObject.frames.length == 1) {
          currentObject._drawFrameFromIndex(0);
        }
        if (config.onFrame) {
	  config.onFrame(frame, currentObject.frames.length);
        }
      },
      onConfig(conf) {
        currentObject.videoWidth = conf.codedWidth;
        currentObject.videoHeight = conf.codedHeight;
        if (config.onConfig) {
	  config.onConfig();
        }
        console.log(conf.mp4boxFile);
        console.log(conf.info);
        const fps = conf.info.videoTracks[0].nb_samples / (conf.info.videoTracks[0].samples_duration / conf.info.videoTracks[0].timescale);
        console.log("fps", fps);
        if (fps < 120) {
          this.fps = fps;
          console.log("Setting fps to " + fps);
        } else {
          console.log("Found weird fps settings, default to 24fps: " + fps);
          this.fps = 24;
        }
        // currentObject.mp4boxFile = conf.mp4boxFile;
        const jsonComments = currentObject.extractJsonFromVideo(conf.mp4boxFile);
        if (jsonComments) {
          try {
            currentObject.jsonComments = JSON.parse(jsonComments);
            console.log("The video contains the following json: ", currentObject.jsonComments)
            if (config.stops) {
              if (typeof config.stops === 'string' || config.stops instanceof String) {
                currentObject.setStopsFromString(config.stops);
              } else {
                currentObject.setStops(config.stops);
              }
              console.log("We got from the configuration the following list of stops:", currentObject.stops);
            } else {
              if (currentObject.jsonComments.stops) {
                currentObject.stops = currentObject.jsonComments.stops;
              } else {
                currentObject.alert("The metadata contains no information about stops: " + jsonComments)
                console.log(currentObject.jsonComments);
              }
            }
          } catch (e) {
            console.log("Error: could not load the json due to a syntax error " + jsonComments, e);
            currentObject.alert("Error: could not load the json due to a syntax error" + jsonComments);
          }
        } else {
          currentObject.alert("No json in the video, you need to load it manually.");
        }
        currentObject.isReady = true;
      },
      onFinish() {
        console.log("Video loaded.");
        currentObject.isLoadingVideo = false;
        currentObject.total_nb_frames = currentObject.frames.length;
        if (config.onFinish) {
	  config.onFinish();
        }
      },
    });
  }

  _ensureStoppedAnimationFrameFetching() {
    if (this.animationFrameIDFetching) {
      cancelAnimationFrame(this.animationFrameIDFetching)
      this.animationFrameIDFetching = null;
    }
  }

  // Basically all animations should start and stop with this._ensureStoppedAnimationFrame()
  _ensureStoppedAnimationFrame() {
    this.isPlayingUntil = undefined;
    this.isPlayingUntilPrevious = undefined;
    this._ensureStoppedAnimationFrameFetching();
    if (this.animationFrameID) {
      cancelAnimationFrame(this.animationFrameID)
      this.animationFrameID = null;
    }
  }

  // Draw a frame on the canvas.
  // warning: for this to work, make sure to put it into an animationFrame or to call waitRedraw
  _drawFrame(frame) {
    // fit in the canvas while preserving the proportions
    const aspectRatioCanvas = this.canvas.width/this.canvas.height;
    const aspectRatioFrame = this.videoWidth/this.videoHeight;
    var w;
    var h;
    if (aspectRatioFrame >= aspectRatioCanvas) {
      // maximum width
      w = this.canvas.width;
      h = w/aspectRatioFrame;
    } else {
      // maximum height
      h = this.canvas.height;
      w = h*aspectRatioFrame;
    }
    // fill the canvas with black
    this.ctx.fillStyle = "black";
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    console.log("I will draw the frame", frame);
    this.ctx.drawImage(frame, this.canvas.width/2-w/2, this.canvas.height/2-h/2, w, h);
  }

  // like _drawFrame but takes as argument the index of the frame, and loops with requestAnimationFrame
  // until the frame is loaded if the file is not yet ready to use.
  async _drawFrameFromIndex(i, silentError) {
    this._ensureStoppedAnimationFrameFetching();
    if (i < this.frames.length) {
      this._drawFrame(this.frames[i]);
      this.currentFrame = i;
      this.lastDrawnFrame = i;
      this._ensureStoppedAnimationFrameFetching();
      return true;
    } else if (this.isLoadingVideo) {
      return await new Promise(resolve => {
        this.animationFrameIDFetching = requestAnimationFrame(async () => {return await this._drawFrameFromIndex(i, silentError); resolve()});
      });
    } else if (i == Infinity) {
      return await this._drawFrameFromIndex(this.frames.length-1, silentError);
    } else {
      if(!silentError){
        const str = `Error: Unreachable frame (frame ${i} bigger than ${this.frames.length}).`;
        this.alert(str);
        console.log(str);
        throw new Error(str);
      }
      return false;
    }
  }

  async gotoFrame(i) {
    console.log("goto",i);
    this._ensureStoppedAnimationFrame();
    await this._drawFrameFromIndex(i);
    // triggers a refresh
    await this.waitRedraw();
    this._ensureStoppedAnimationFrame();
  }

  async gotoPage(i) {
    const pages = [...new Set([...this.stops, 0, Infinity])];
    if (i >= pages.length) {
      await this.gotoFrame(Infinity)
    } else {
      await this.gotoFrame(pages[i])
    }
  }

  getCurrentPage() {
    const pages = [...new Set([...this.stops, 0, Infinity])];
    return pages.filter(e => e <= this.currentFrame).reduce((iMax, x, i, arr) => x > arr[iMax] ? i : iMax, 0);
  }
  
  getNumberOfFramesIfPossible() {
    if (!this.isLoadingVideo) {
      return this.frames.length;
    } else if (this.jsonComments?.finalVideo?.length) {
      return this.jsonComments?.finalVideo?.length;
    } else {
      return null
    }
  }

  getNumberOfPages() {
    const nbFrames = this.getNumberOfFramesIfPossible();
    if (nbFrames) {
      return [...new Set([...this.stops, 0, nbFrames-1])].length;
    } else {
      return [...new Set([...this.stops, 0])].length;
    }
  }

  async gotoFrameGUI(i) {
    const nbFrames = this.getNumberOfFramesIfPossible();
    const answer = prompt("To which frame do you want to go? (currently " + this.currentFrame + "/" + nbFrames + ")");
    if (answer) {
      this.gotoFrame(parseInt(answer));
    }
  }

  async specifyStopsGui(i) {
    const answer = prompt("Provide the list of stops to use (e.g. '1, 2, 3').");
    if (answer) {
      this.stops = [...new Set(answer.split(",").map(e => parseInt(e)))].sort(function(a, b) {
        return a - b;
      });
    }
  }
  
  
  // call "await this.waitRedraw()" to wait for animationFrame to
  waitRedraw() {
    return new Promise(resolve => {
      this.animationFrameID = requestAnimationFrame(() => {resolve()});
    });
  }

  // play at the max FPS allowed by the screen refresh rate.
  async playAtMaxSpeed() {
    const nextFrame = this.currentFrame + 1;
    const notTheLastOne = await this._drawFrameFromIndex(nextFrame, true);
    if(notTheLastOne) {
      await this.waitRedraw();
      this.playAtMaxSpeed();
    }
    else {
      console.log("Finished to draw");
      this._ensureStoppedAnimationFrame();
    }
  }

  // frame is optional, return the next stop. It might return Infinity if there is none
  getNextStop(frame) {
    const initialFrame = frame || this.currentFrame;
    console.log(this.stops);
    console.log(initialFrame)
    const st = this.stops.filter(e => e > initialFrame);
    if (st.length == 0) {
      return Infinity
    } else {
      return Math.min(...st);
    }
  }

  // frame is optional
  getPreviousStop(frame) {
    const initialFrame = frame || this.currentFrame;
    const st = this.stops.filter(e => e < initialFrame);
    return Math.max(0, ...st);
  }

  // nextstop is optional, it will be automatially computed if needed. Set to Infinity if you want to play until the end.
  async playUntilNextStop(stop) {
    // If we click while playing, we jump to the stop directly:
    console.log("called playuntil");
    if (!this.isReady) {
      console.log("The file is not yet ready, wait a bit more.");
      return
    }
    if (this.isPlayingUntil != undefined) {
      console.log("I am playing until");
      await this.gotoFrame(this.isPlayingUntil);
      return
    }
    if (this.isPlayingUntilPrevious != undefined) {
      console.log("I am playing until previous");
      await this.gotoFrame(this.currentFrame);
      return
    }
    console.log("We were apparently not playing");
    // We first compute the next stop
    const initialFrame = this.currentFrame;
    const nextStop = stop || this.getNextStop();
    console.log(nextStop, stop);
    const initTime = Date.now();
    this.isPlayingUntil = nextStop;
    const playAux = async () => {
      const deltaTime = (Date.now() - initTime)/1000;
      const frameToDisplay = Math.min(Math.round(deltaTime * this.fps * this.playbackSpeed) + initialFrame, nextStop);
      console.log("frameToDisplay", frameToDisplay);
      const notTheLastOne = await this._drawFrameFromIndex(frameToDisplay, true);
      if(notTheLastOne && frameToDisplay < nextStop) {
        await this.waitRedraw();
        await playAux();
      }
      else {
        console.log("stop");
        this.isPlayingUntil = undefined;
        this._ensureStoppedAnimationFrame();
      }
    }
    await playAux();
  }
  
  // nextstop is optional, it will be automatially computed if needed. Set to Infinity if you want to play until the end.
  async playUntilPreviousStop(stop) {
    if (!this.isReady) {
      console.log("The file is not yet ready, wait a bit more.");
      return
    }
    // If we click while playing, we jump to the stop directly:
    console.log("called playuntilprevious");
    if (this.isPlayingUntilPrevious != undefined) {
      await this.gotoFrame(this.isPlayingUntilPrevious);
      return
    }
    // if we were playing forward, we stop here
    if (this.isPlayingUntil != undefined) {
      await this.gotoFrame(this.currentFrame);
      return
    }
    // First stop the play
    this._ensureStoppedAnimationFrame()
    // We first compute the next stop
    const initialFrame = this.currentFrame;
    const nextStop = stop || this.getPreviousStop();
    console.log("Will play until ", nextStop);
    const initTime = Date.now();
    console.log(nextStop);
    this.isPlayingUntilPrevious = nextStop;
    const playAux = async () => {
      const deltaTime = (Date.now() - initTime)/1000;
      const frameToDisplay = Math.max(-Math.round(deltaTime * this.fps * this.playbackSpeed) + initialFrame, nextStop);
      const notTheLastOne = await this._drawFrameFromIndex(frameToDisplay, true);
      if(notTheLastOne && frameToDisplay > nextStop) {
        await this.waitRedraw();
        await playAux();
      }
      else {
        console.log("stop");
        this.isPlayingUntilPrevious = undefined;
        this._ensureStoppedAnimationFrame();
      }
    }
    await playAux();
  }

  
  // stop is optional, it will be automatially computed
  async gotoPreviousStop(stop) {
    if (!this.isReady) {
      console.log("The file is not yet ready, wait a bit more.");
      return
    }
    // First stop the play
    this._ensureStoppedAnimationFrame();
    const previousStop = stop || this.getPreviousStop();
    return await this.gotoFrame(previousStop);
  }

  async gotoPreviousFrame() {
    await this.gotoFrame(this.currentFrame - 1)
  }

  async gotoNextFrame() {
    await this.gotoFrame(this.currentFrame + 1)
  }


  async pause() {
    this._ensureStoppedAnimationFrame();
  }

  async togglePlayPause() {
    if (this.isPlaying()) {
      this._ensureStoppedAnimationFrame();
    } else {
      this.playUntilNextStop(Infinity)
    }
  }
  
  async canvasChangeSize(width, height) {
    /* When the openFullscreen() function is executed, open the video in fullscreen.
       Note that we must include prefixes for different browsers, as they don't support the requestFullscreen method yet */
    this.origCanvasWidth = this.canvas.width;
    this.origCanvasHeight = this.canvas.height;

    this.canvas.width = width;
    this.canvas.height = height;
    this.redrawWhenResolutionChanges()
  }

  async restoreCanvasSize() {
    /* When the openFullscreen() function is executed, open the video in fullscreen.
       Note that we must include prefixes for different browsers, as they don't support the requestFullscreen method yet */
    this.canvas.width = this.origCanvasWidth;
    this.canvas.height = this.origCanvasHeight;
    this.redrawWhenResolutionChanges()
  }

  async redrawWhenResolutionChanges() {
    if (!this.isPlaying()) { // No need to draw if it’s already playing
      await this._drawFrameFromIndex(this.currentFrame);
      await this.waitRedraw();
      this._ensureStoppedAnimationFrame(); // otherwise it thinks that it is still playing.
      console.log("we are not playing")
    } else {
      console.log("we are playing")
    }
  }


  close() {
    this.frames.forEach(frame => {
      frame.close();
    });
  }

  getInfoOnFrame(frame) {
    var data = {frame: frame};
    if (this.jsonComments.clipsIndex) {
      for (var clip of this.jsonComments.clipsIndex) {
        const relativeFrame = frame - clip.absoluteStart;
        if (relativeFrame >= 0 && relativeFrame < clip.length) {
          data.clipFilename = clip.filename;
          data.clipAbsoluteStart = clip.absoluteStart
          data.frameFinalPositionFromStartClip = relativeFrame;
          if (clip.frameFinalToOriginal) {
            // frame number in the original clip
            data.originalLocalFrame = clip.frameFinalToOriginal[relativeFrame];
          }
          return data
        }
      }
    }
    return data;
  }
  
  logFrame(frame) {
    var info = this.getInfoOnFrame(frame);
    var message = "The final frame number is " + info.frame;
    if (info.clipAbsoluteStart) {
      message += " (= clip starting at frame " + info.clipAbsoluteStart + " + " + info.frameFinalPositionFromStartClip + " frames)";
    }
    if (info.clipFilename) {
      message += ", extracted from the clip " + info.clipFilename;
    }
    if (info.originalLocalFrame) {
      message += " at original position " + info.originalLocalFrame;
    }
    this.frameLog(message);
  }

  async action(actionType, actionData) {
    switch (actionType) {
      case 'loadVideoFileFromObjectURL':
        this.loadVideoFileFromObjectURL(actionData.videoObjectURL, actionData.config);
        break;
      case 'playUntilNextStop':
        this.playUntilNextStop();
        break;
      case 'playUntilPreviousStop':
        this.playUntilPreviousStop();
        break;
      case 'togglePlayPause':
        this.togglePlayPause();
        break;
      case 'gotoNextFrame':
        this.gotoNextFrame();
        break;
      case 'gotoPreviousFrame':
        this.gotoPreviousFrame();
        break;
      case 'gotoPreviousStop':
        this.gotoPreviousStop(actionData);
        break;
      case 'pause':
        this.pause();
        break;
      case 'playAtMaxSpeed':
        this.playAtMaxSpeed();
        break;
      case 'gotoFrame':
        this.gotoFrame(actionData);
        break;
      case 'gotoPage':
        this.gotoPage(actionData);
        break;
      case 'logFrame':
        if (actionData === undefined)
          this.logFrame(actionData || this.currentFrame);
        break;
      case 'addStop':
        this.stops = [...new Set([...this.stops, this.currentFrame])].sort(function(a, b) {
          return a - b;
        });
        console.log(this.stops);
        break;
      case 'removeStop':
        this.stops = this.stops.filter(x => x !== this.currentFrame)
        console.log(this.stops);
        break;        
      case 'setStops':
        this.setStops(actionData);
        break;
      case 'getStops':
        this.postMessage({result: this.getStops()});
        break;
      case 'getCurrentPage':
        this.postMessage({result: this.getCurrentPage()});
        break;
      case 'getNumberOfPages':
        this.postMessage({result: this.getNumberOfPages()});
        break;
      case 'getNumberOfFramesIfPossible':
        this.postMessage({result: this.getNumberOfFramesIfPossible()});
        break;
      case 'getInfoOnFrame':
        this.postMessage({result: this.getInfoOnFrame(actionData)});
        break;
      case 'loadVideoFileFromFile':
        this.loadVideoFileFromFile(actionData.file, actionData.config);
        break;
      case 'redrawWhenResolutionChanges':
        this.redrawWhenResolutionChanges();
        break;
      case 'restoreCanvasSize':
        this.restoreCanvasSize();
        break;
      case 'canvasChangeSize':
        this.canvasChangeSize(actionData.width, actionData.height);
        break;
      case 'close':
        this.close();
        break;
      case 'setFps':
        this.setFps(actionData)
        break;
    }
  }
}

self.bpVideo = null;
self.onmessage = function(msg) {
  if (msg.data.canvas) {
    console.log("Hey from worker!");
    const config = msg.data.config || {};
    self.bpVideo = new BlenderpointVideoWorker(msg.data.canvas, config);
  }
  if (msg.data.blenderpointActionType) {
    if (self.bpVideo) {
      bpVideo.action(msg.data.blenderpointActionType, msg.data.blenderpointActionData);
    } else {
      self.postMessage({error: "You must first load a video before interacting with it."});
    }
  }
}
