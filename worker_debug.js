// Wraps an MP4Box File as a WritableStream underlying sink.
// https://w3c.github.io/webcodecs/samples/video-decode-display/

const currentWorker = self;
const wait = (n) => new Promise((resolve) => setTimeout(resolve, n));

class MyMP4FileSink {
  #setStatus = null;
  #file = null;
  #offset = 0;
  
  constructor(file, setStatus) {
    this.#file = file;
    this.#setStatus = setStatus;
  }
  
  write(chunk) {
    // MP4Box.js requires buffers to be ArrayBuffers, but we have a Uint8Array.
    const buffer = new ArrayBuffer(chunk.byteLength);
    new Uint8Array(buffer).set(chunk);
    
    // Inform MP4Box where in the file this chunk is from.
    buffer.fileStart = this.#offset;
    this.#offset += buffer.byteLength;
    
    // Append chunk.
    this.#setStatus("fetch", (this.#offset / (1024 ** 2)).toFixed(1) + " MiB");
    this.#file.appendBuffer(buffer);
  }
  
  close() {
    this.#setStatus("fetch", "Done");
    this.#file.flush();
  }
}
 
 
 // Demuxes the first video track of an MP4 file using MP4Box, calling
 // `onConfig()` and `onChunk()` with appropriate WebCodecs objects.
 // // https://w3c.github.io/webcodecs/samples/video-decode-display/
 class MyMP4Demuxer {
   #onConfig = null;
   #onChunk = null;
   #onFinish = null;
   #setStatus = null;
   #file = null;
 
   constructor(uri, {onConfig, onChunk, onFinish, setStatus}) {
     this.#onConfig = onConfig;
     this.#onChunk = onChunk;
     this.#onFinish = onFinish;
     this.#setStatus = setStatus;
 
     // Configure an MP4Box File for demuxing.
     this.#file = MP4Box.createFile();
     this.#file.onError = error => {
       console.error(error);
       setStatus("demux", error);
     }
     this.#file.onReady = this.#onReady.bind(this);
     this.#file.onSamples = this.#onSamples.bind(this);
 
     // Fetch the file and pipe the data through.
     const fileSink = new MyMP4FileSink(this.#file, setStatus);
     console.log("We will fetch uri:", uri);
     fetch(uri).then(async response => {
       // highWaterMark should be large enough for smooth streaming, but lower is better for memory usage.
       await response.body.pipeTo(new WritableStream(fileSink, {highWaterMark: 2}));
       await this.#file.flush();
       if(this.#onFinish) this.#onFinish();
     });
   }
 
   // Get the appropriate `description` for a specific track. Assumes that the
   // track is H.264 or H.265.
   #description(track) {
     const trak = this.#file.getTrackById(track.id);
     for (const entry of trak.mdia.minf.stbl.stsd.entries) {
       if (entry.avcC || entry.hvcC) {
         const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
         if (entry.avcC) {
           entry.avcC.write(stream);
         } else {
           entry.hvcC.write(stream);
         }
         return new Uint8Array(stream.buffer, 8);  // Remove the box header.
       }
     }
     throw "avcC or hvcC not found";
   }
 
   #onReady(info) {
     this.#setStatus("demux", "Ready");
     const track = info.videoTracks[0];
 
     // Generate and emit an appropriate VideoDecoderConfig.
     this.#onConfig({
       codec: track.codec,
       codedHeight: track.video.height,
       codedWidth: track.video.width,
       description: this.#description(track),
       mp4boxFile: this.#file,
       info: info,
     });
 
     // Start demuxing.
     this.#file.setExtractionOptions(track.id);
     this.#file.start();
   }
 
   async #onSamples(track_id, ref, samples) {
     console.debug("Received multiple samples (aka frames): ");
     // console.debug(track_id, ref, samples);
     // Generate and emit an EncodedVideoChunk for each demuxed sample.
     for (const sample of samples) {
       // console.debug(sample.is_sync);
       this.#onChunk(new EncodedVideoChunk({
         type: sample.is_sync ? "key" : "delta",
         timestamp: 1e6 * sample.cts / sample.timescale,
         duration: 1e6 * sample.duration / sample.timescale,
         data: sample.data,
       }));
     }
   }
 }

// https://stackoverflow.com/questions/6902334/how-to-let-javascript-wait-until-certain-event-happens
function getPromiseFromEvent(item, event, functionSaveListener) {
  return new Promise((resolve) => {
    const listener = (e) => {
      item.removeEventListener(event, listener);
      resolve(e);
    }
    if(functionSaveListener) {
      functionSaveListener(listener);
    }
    item.addEventListener(event, listener);
  })
}

// Wait for an event to trigger, run f, if f is true stops, otherwise restart until finding a valid event.
async function waitEventUntil(item, event, f, functionSaveListener) {
  const e = await getPromiseFromEvent(item, event);
  if (f(e)) {
    return e
  } else {
    return await waitEventUntil(item, event, f, functionSaveListener)
  }
}

async function waitEventUntilWithAbort(item, event, f, functionSaveListener, abortIfNeeded) {
  console.debug("abortIfNeeded", abortIfNeeded);
  const e = await abortIfNeeded(getPromiseFromEvent(item, event, functionSaveListener), "01");
  if (f(e)) {
    return e
  } else {
    return await abortIfNeeded(waitEventUntilWithAbort(item, event, f, functionSaveListener, abortIfNeeded));
  }
}

// dequeue is not enough, as it seems to run before the call to output.
// the event value is the id of the newly cached frame.
const newCachedFrame = new Event("newCachedFrame");
/* self.addEventListener("newCachedFrame", (e) => {console.debug("Dummy");})
 * setTimeout(() => self.dispatchEvent(newCachedFrame, 42), 2000);
 * await waitEventUntil(self, "newCachedFrame", () => true);
 * console.debug("Yeahhh Received!"); */


// Needed to abort everything when a new function is called by the user.
// https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal#implementing_an_abortable_api
function makeMeAbortIfNeeded(promise, signal, debug) {
  return new Promise((resolve, reject) =>{
    // If the signal is already aborted, immediately throw in order to reject the promise.
    if (signal.aborted) {
      console.debug("Stopped before promise", promise);
      reject(signal.reason);
    }
    const myListener = () => {
      // Why isn't this working?? It s
      console.debug("Just received a signal to abort");
      // Stop the main operation
      // Reject the promise with the abort reason.
      // WARNING: if the promise itself contains non blocking stuff, it will still continue to run.
      console.debug("Stopped during promise", promise, debug);
      reject(signal.reason);
      //reject(new Error(debug));
    };
    promise.then(x => {
      signal.removeEventListener("abort", myListener);
      resolve(x);
    });

    signal.addEventListener("abort", myListener, {once: true});
  });
}

// catches the abort. Only use if you do NOT await for efficiency reasons for instance. Otherwise the
// next code will just run normally.
function silentlyAbort(promise) {
  return promise.catch(error => {
    console.debug("I just got error", error);
  });
}

// Used to get the frames in order to 
class GetAnyFrame {

  constructor(videoUri, userConfig) {
    this.videoUri = videoUri;
    // Note that this value is not strictly respected, as we cache elements by chuncks (of size the number of
    // elements between two key frames, in my tests it is often around 250). But we will start to
    // garbage collect when we go over this limit after caching these elements, so in total we can go up to
    // roughly this.maxNumberCachedFrames + 250. Note that the chunk just loaded cannot be garbage collected.
    // From https://w3c.github.io/webcodecs/#videodecoder-interface
    // "Authors are encouraged to call close() on output VideoFrames immediately when frames are no longer needed."
    // The underlying media resources are owned by the VideoDecoder and failing to release them (or waiting for
    // garbage collection) can cause decoding to stall."
    this.maxNumberCachedFrames = userConfig.maxNumberCachedFrames || 5;
    this.nbFramesDecodeInAdvance = userConfig.minNumberCachedFrames || 5;
    this.minNumberCachedFrames = Math.max(this.nbFramesDecodeInAdvance, userConfig.minNumberCachedFrames || 3);
    this.maxDecodeQueueSize = Math.max(this.minNumberCachedFrames, userConfig.maxDecodeQueueSize || 10);
    console.log("this.maxNumberCachedFrames", this.maxNumberCachedFrames, "this.nbFramesDecodeInAdvance", this.nbFramesDecodeInAdvance, "this.minNumberCachedFrames", this.minNumberCachedFrames, "this.maxDecodeQueueSize", this.maxDecodeQueueSize);
    // cachedFrames[i] = {
    //   frame: frame,
    //   priorityRemove: // higher says that the image should be garbage collected later. Infinity means that
    //                     the image should never be garbage collected (e.g. if we want stop point to always
    //                     stay in the cache). See nextPriorityRemove to determine.
    // }
    // We use map instead of dictionaries/object since dictionaries do not provide efficient way to compute the
    // length, needed to clean the cache (so use .get/.set).
    // https://stackoverflow.com/questions/37382231/fast-alternative-to-object-keysobj-length
    this.cachedFrames = new Map();
    this.nextPriorityRemove = 0;
    
    // This contains all non-decoded frames in format:
    // {
    //   nonDecodedFrame: ...;
    //   idParentKeyFrame: id of key frame needed to decode (not the delta one)
    //   idNextKeyFrame: id of next key frame, needed to decode the whole block as we must restart from a key frame after a flush https://github.com/w3c/webcodecs/issues/220
    // }
    // It will take wayyy less memory than decoded
    // frames (hopefully), while allowing fast access (and later we might be able to optimize
    // it better by just storing the offset in the url file, but I am not sure how to do, so let's do
    // one step at a time).
    this.allNonDecodedFrames = [];
    // Only needed to obtain the parent keyframe of the currently demuxed frame
    this.lastDecodedFrame = null;
    // One option to map the decoded frame with its ID is to use a new queue with the id of frame currently
    // getting decoded. But since we reset the decoder when starting from an unrelated keyframe, it means that this queue would look like: [i, i+1, i+2, i+3, i+4, ...]. Instead, we store just "i" in the following variable,
    // denoting the id of the frame that will be decoded next, and we increase it when a new frame is decoded.
    this.idOfNextDecodedKeyFrame = null; 

    // Useful to remove the listener
    this.getFrameListener = null;
    
    // Fetch and demux the media data (i.e. basically extract the key and delta frames with decompressing them
    // into a real image).
    this.demuxer = new MyMP4Demuxer(this.videoUri, {
      onConfig: (config) => {
        this._onConfig(userConfig,config);
      },
      onFinish: async () => {
        await this._onFinishDemuxer(userConfig);
      },
      // a chunk is a non decoded frame
      onChunk: (chunk) => {
        // Check if this is a key frame
        if (chunk.type == "key") {
          this.lastKeyframe = this.allNonDecodedFrames.length;
        }
        if (this.lastKeyframe === undefined) {
          console.log("Error: the last key frame is undefined, which should NEVER appear if you start to decode from a key frame. ");
        }
        this.allNonDecodedFrames.push({
          nonDecodedFrame: chunk,
          idParentKeyFrame: this.lastKeyframe // we will add idNextKeyFrame later in _onFinishDemuxer
        });
      },
      // TODO: make this useful
      setStatus: (a, b) => {
        console.debug("status:", a, b);
      },
    });

    this.decoderConfig = null;
    this.decoder = new VideoDecoder({
      output: this._onDecodedFrame.bind(this),
      error: (e) => {
        console.debug("I just got an error during decoding:", e);
        /* console.error(e); */
        // This does not exist for now: more cleanly deal with error later.
        setStatus("decode", e);
      },
    });

    // So that we know if we need to reset or not
    this.nextFrameToAskForDecode = 0;

    this._getMainAbortSignal = userConfig._getMainAbortSignal;
  }

  abortIfNeeded(promise, debug) {
    return makeMeAbortIfNeeded(promise, this._getMainAbortSignal(), debug);
  }
  
  getVideoWidth() {
    return this.videoWidth;
  }

  getVideoHeight() {
    return this.videoHeight;
  }

  _onConfig(userConfig, config) {
    if(userConfig.onConfigDemuxer) userConfig.onConfigDemuxer(config);
    this.decoderConfig = config;
    this.decoderConfig.optimizeForLatency = true;
    this.videoWidth = config.codedWidth;
    this.videoHeight = config.codedHeight;
    const fps = config.info.videoTracks[0].nb_samples / (config.info.videoTracks[0].samples_duration / config.info.videoTracks[0].timescale);
    console.debug("fps", fps);
    if (fps < 120) {
      this.fps = fps;
      console.log("Setting fps to " + fps);
    } else {
      console.log("Found weird fps settings, default to 24fps: " + fps);
      this.fps = fps;
    }
    if (userConfig._onConfig) {
      userConfig._onConfig(config);
    }
    if (userConfig.onConfig) {
      userConfig.onConfig(config);
    }
    // We configure the decoder (specify which codec we use etc)
    this.decoder.configure(this.decoderConfig);
  }
  
  async _onFinishDemuxer(userConfig) {
    // We compute idNextKeyFrame now, by going through the array starting from the end.
    // Another option might be to do it at the end of demuxing a group of frames, but I am not 100% sure
    // if we always end on a keyFrame, so let's do it here for safety.
    // At the very end, the lastKeyFrame will be the "next" frame (not existing in the array):
    var lastKeyFrame = this.allNonDecodedFrames.length;
    for(var i = this.allNonDecodedFrames.length - 1; i >= 0; i--) {
      this.allNonDecodedFrames[i].idNextKeyFrame = lastKeyFrame;
      if (this.allNonDecodedFrames[i].nonDecodedFrame.type == "key") {
        lastKeyFrame = i;
      }
    }
    // We just finished to demux the whole file, so this.allNonDecodedFrames is properly set.
    console.log("We just finished to demux the whole file.", this.allNonDecodedFrames);
    if(userConfig._onFinishDemuxer) {
      await userConfig._onFinishDemuxer();
    }
    if(userConfig.onFinishDemuxer) {
      await userConfig.onFinishDemuxer();
    }
  }
  
  _onDecodedFrame(frame) {
    console.debug("starting onDecodedFrame");
    var idFrame = this.idOfNextDecodedKeyFrame;
    this.idOfNextDecodedKeyFrame++;
    // We add the frame to the cache
    console.debug("We are adding to the cache the frame", idFrame, "with priority", this.nextPriorityRemove);
    this.cachedFrames.set(idFrame, {
      frame: frame,
      lastAccessed: this.nextPriorityRemove
    });
    this.nextPriorityRemove++;
    currentWorker.dispatchEvent(newCachedFrame, {id: idFrame});
    console.debug("ending onDecodedFrame");
  }

  // We can specify an element not to garbage collect (useful to keey the last value that was decoded)
  // Cleans the frame to ensure the memory contains only a small number of decoded frames.
  _garbageCollectFrames(fromIdFrameNotToGarbageCollect, toExcludedIdFrameNotToGarbageCollect) {
    console.debug("In _garbageCollectFrames");
    // If there were an error, for instance we stopped the function due to a race condition, no need to garbage
    // collect now.
    if(toExcludedIdFrameNotToGarbageCollect < 0) {
      return;
    };
    console.debug("garbage starting items", this.cachedFrames.size);
    // we add a -1 so that we do not count the current frame
    if(this.cachedFrames.size - 1 > this.maxNumberCachedFrames) {
      // We sort the element to remove them.
      // .entries outputs an array [key, value]
      const orderedElements = [...this.cachedFrames.entries()].filter(x => x[1].priorityRemove != Infinity && (x[0] < fromIdFrameNotToGarbageCollect || x[0] >= toExcludedIdFrameNotToGarbageCollect)).sort((a, b) => a[1].priorityRemove - b[1].priorityRemove);
      // nb elements beginning: this.cachedFrames.size
      // nb elements end: this.minNumberCachedFrames
      // nb elements to remove = 
      const nbElementsToRemove = Math.min(
        // We cannot remove more elements as the other elements are protected from being removed
        orderedElements.length,
        this.cachedFrames.size - this.minNumberCachedFrames);
      for (var i=0; i < nbElementsToRemove; i++) {
        this.cachedFrames.get(orderedElements[i][0]).frame.close();
        this.cachedFrames.delete(orderedElements[i][0]);
        orderedElements[i][1].frame.close();
      }
    }
    console.debug("garbage ending items", this.cachedFrames.size);
  }

  // Make sure that all elements between idFrom and idToExcluded are in the cache. It returns the last element
  // that was send to decode (might be larger, like +10 due to latency of codec), useful for preserving it in the cache.
  async _forceAddInCache(idFrom, idToExcluded) {
    console.debug("In _forceAddInCache");
    // We want to make sure we do not call this function twice (race conditions on the decoder could be fairly bad).
    // So we increment a public counter when we start this function, and all functions that are currently running
    // with a lower counter stop. Seems there is no other way?
    // https://stackoverflow.com/questions/26298500/stop-pending-async-function-in-javascript
    console.debug("Starting _forceAddInCache", "from", idFrom, "to", idToExcluded);
    // Make sure they are not too large, and properly ordered
    if(idFrom >= this.allNonDecodedFrames.length) { return -1 }
    idToExcluded = Math.min(idToExcluded, this.allNonDecodedFrames.length);
    if(idFrom >= idToExcluded) { return -1 }

    // Depending on the codec, we might need to push many (~10?) frames until seing a frame.
    // https://github.com/w3c/webcodecs/issues/753
    // So the trick (also for efficiency), is to send decode messages until we see enough messages.
    // In the examble https://webcodecs-samples.netlify.app/audio-video-player/audio_video_player.html
    // they even try to saturate the decoder by keeping sending decode messages until the queue starts to grow.
    // Let us try.
    
    // We check if we can continue from where we are right now
    var nextElementToDecode = null;
    // If we are after the frame that will be decoded next, and if we share the same parent key, we can
    // just continue to decode normally, otherwise we first need to reset:
    console.debug(idFrom, this.allNonDecodedFrames[idFrom].idParentKeyFrame, this.idOfNextDecodedKeyFrame);
    if (idFrom >= this.idOfNextDecodedKeyFrame
        && this.idOfNextDecodedKeyFrame !== null
        && this.allNonDecodedFrames[idFrom].idParentKeyFrame
      == this.allNonDecodedFrames[this.idOfNextDecodedKeyFrame].idParentKeyFrame
    ) {
      console.debug("I can just continue my usual work, starting to decode frame ", this.nextFrameToAskForDecode);
    } else {
      console.log("We will reset the decoder.");
      // We restart from a completely unrelated keyframe: we need to reset the decoder. If not we reset:
      this.decoder.reset();
      // Resetting also gets rid of the configuration, so we need to reconfigure it (not sure if we lose
      // efficiency here, but this is done only when we do a jump of frames)
      this.decoder.configure(this.decoderConfig);
      // If we reset, we need to restart from a key frame:
      console.debug("this.allNonDecodedFrames[idFrom]", idFrom, this.allNonDecodedFrames[idFrom]);
      nextElementToDecode = this.allNonDecodedFrames[idFrom].idParentKeyFrame;
      this.idOfNextDecodedKeyFrame = nextElementToDecode;
      this.nextFrameToAskForDecode = nextElementToDecode;
      /* for(var j = this.allNonDecodedFrames[idFrom].idParentKeyFrame; j < idToExcluded; j++){
       *   console.debug("_forceAddInCache: decode ", j);
       *   this.decoder.decode(this.allNonDecodedFrames[j].nonDecodedFrame);
       * } */
    } 
    console.debug("We will start by decoding", this.nextFrameToAskForDecode);
    // We send decode until we find our beloved element (we can also try to saturate even more if needed
    // as done in the example). But before we remove the last element in case it is already in the cache.
    if (this.cachedFrames.has(idToExcluded)) {
      this.cachedFrames.get(idToExcluded).frame.close();
      this.cachedFrames.delete(idToExcluded);
    }
    while (!this.cachedFrames.has(idToExcluded)) {
      // Someone else started to run this function. Let us stop then.
      if (this.decoder.decodeQueueSize > this.maxDecodeQueueSize) {
        console.log("The decoder is overwhelmed (even in debug mode), let's wait before sending new stuff in the queue of size: ", this.decoder.decodeQueueSize);
      } else {
        console.debug("Starting to decoding frame ", this.nextFrameToAskForDecode, this.decoder.decodeQueueSize, this.maxDecodeQueueSize);
        if(this.nextFrameToAskForDecode >= this.allNonDecodedFrames.length) {
          // We arrived at the end of the video: let us flush (unless someone else is already running this function)
          await this.abortIfNeeded(this.decoder.flush(), "flush");
          return nextElementToDecode;
        } else {
          this.decoder.decode(this.allNonDecodedFrames[this.nextFrameToAskForDecode].nonDecodedFrame);
          this.nextFrameToAskForDecode++;
        }
      }
      // since the decoding is asynchronously done, we need to stop temporarily the code to give
      // time to the decoder to run.
      // This is needed, otherwise the decoder will not have time to start its job and we will get into
      // an infinite loop.
      console.debug("Give a bit of time to decoder");
      await this.abortIfNeeded(wait(4), "foowait");
      console.debug("Decoder had enough time");
    }
    return nextElementToDecode;
  }

  getNumberOfFramesIfPossible() {
    return this.allNonDecodedFrames.length;
  }
  
  async _forceAddInCacheAndGarbageCollect(idFrom, idToExcluded, idFromGC, idToGC) {
    console.debug("In _forceAddInCacheAndGarbageCollect");
    await this.abortIfNeeded(this._forceAddInCache(idFrom, idToExcluded), "foo _forceAddInCacheAndGarbageCollect");
    if (idToGC === undefined) {
      idToGC = this.nextFrameToAskForDecode;
    }
    if (idFromGC === undefined) {
      idFromGC = idFrom;
    }
    this._garbageCollectFrames(idFromGC, idToGC);
  }
  
  // distance is the number of frame to try before giving up. Return either null or the id of the first frame
  _findFirstNonCachedFrame(idFrame, distance) {
    for (var j=0; j <= distance; j++) {
      if(!this.cachedFrames.has(idFrame+j)) {
        return idFrame+j;
      }
    }
    return -1;
  }
  
  // TODO: make it work also if the frame is not yet available (loading video), or if i = Infinity to get the
  // last frame. Get inspired by commented code in _drawFrameFromIndex
  // The backward is an indication that we should store more frames in the cache not to always recompute the sames
  // This returns -1 if the frame is out of range.
  async getFrame(i, backward, forceInRange) {
    // We check if the frame is in the good range
    if(!forceInRange) {
      if (i < 0 || i >= this.allNonDecodedFrames.length) {
        return null;
      }
    } else {
      if (i < 0) {
        i = 0;
      }
      if (i >= this.allNonDecodedFrames.length) {
        i = this.allNonDecodedFrames.length - 1;
      }
    }
    // If we were already trying to get an image, we stop the older one.
    if (this.getFrameListener) {
      self.removeEventListener("newCachedFrame", this.getFrameListener);
      this.getFrameListener = null;
    }
    // TODO: make it more robust to race conditions.
    console.debug("Calling getFrame with i=", i);
    // Will contain the result of _forceAddInCache
    var nextElementToDecode = -1;
    if (this.cachedFrames.has(i)) {
      console.debug("Frame", i, "already cached.")
      // The frame is already in the cache.
      // This is cool to see a cached frame, but we want to start the decoding of the next frames to have them
      // in due time. No need to do this optimization if we run backward (or at least not this way).
      if(!backward) {
        const firstNonCachedFrame = this._findFirstNonCachedFrame(i, this.nbFramesDecodeInAdvance);
        // console.log("firstNonCachedFrame=",firstNonCachedFrame, "at distance smaller than ", this.nbFramesDecodeInAdvance, this.cachedFrames.has(i+this.nbFramesDecodeInAdvance), this.cachedFrames);
        if (firstNonCachedFrame != -1) {
          // We do not use await on purpose, otherwise it might slow down the process when it fetches new stuff
          silentlyAbort(this._forceAddInCacheAndGarbageCollect(firstNonCachedFrame, i + this.nbFramesDecodeInAdvance + 1,i));
        }
      }
      return this.cachedFrames.get(i).frame;
    } else {
      console.debug("Frame", i, "NOT in the cache.")
      if(backward) {
        // For backward, we don't care te preserve the cache since it is in the other direction.
        // We do not await for efficiency reasons
        silentlyAbort(this._forceAddInCacheAndGarbageCollect(
          this.allNonDecodedFrames[i].idParentKeyFrame, i + 1,
          this.allNonDecodedFrames[i].idParentKeyFrame, i + 1
        ));
      } else {
        console.debug("We will add in the cache", i, i + this.nbFramesDecodeInAdvance + 1);
        // We do not await for efficiency reasons
        silentlyAbort(this._forceAddInCacheAndGarbageCollect(i, i + this.nbFramesDecodeInAdvance + 1));
      }
      // If the decoder saturated, the frame might not be ready yet.
      if(!this.cachedFrames.has(i)) {
        console.debug("The frame is not arrived yet, I'm waiting for it to come…");
        console.debug("this.decoder.decodeQueueSize", this.decoder.decodeQueueSize);
        console.debug("this.abortIfNeeded 0", this.abortIfNeeded);
        await this.abortIfNeeded(waitEventUntilWithAbort(
          self,
          "newCachedFrame",
          () => this.cachedFrames.has(i),
          (l) => {
            this.getFrameListener = l
          },
          this.abortIfNeeded.bind(this)
        ), "foo eiaunrst");
      }
      console.debug("We received the frame");
      return this.cachedFrames.get(i).frame;
    }
  }
  
  getNumberFrame() {
    // TODO: make it work if video not loaded yet
    return 
  }

  clearCache() {
    this.cachedFrames.forEach((value, key) => value.frame.close());
    this.cachedFrames = new Map();
    this.nextPriorityRemove = 0;
  }
  
  close() {
    this.clearCache();
  }
}

// Throw when the user wants to do something else and cancel running code
class UsercancelledError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsercancelledError";
  }
}

  class BlenderpointVideoWorker {
    constructor(canvas, config) {
    config = config || {};
    this.canvas = canvas;
    this.ctx = this.canvas.getContext("2d");
    // We color it in all black
    this.ctx.fillStyle = "pink";
    this.ctx.fill();
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.isLoadingVideo = false;
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
    // Contains the ID to the frame to stop at.
    this.isPlayingUntil = undefined;
    this.isPlayingUntilPrevious = undefined;
    this.animationFrameID = null;
    // This is used only to know if we are running playAtMaxSpeed that works differently
    this.isPlayingMaxSpeed = false;
    // we might also call request animation frame if the user wants to display something on screen
    // while the video is not yet loaded, use this for that use case.
    this.animationFrameIDFetching = null;
    this.stops = []; // contains the list of stops
    this.jsonComments = {}; // contains the content of the json in the comments of the video
    this.alert = (m) => self.postMessage({alert: m});
    this.frameLog = (m) => console.log(m);
    // This will contain the instance of GetAnyFrame
    this.anyFrame = null;
    // 
    this._resetAbortSignal();
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

    // To know the starting frame/date where we started to play (or avoid a frame jump):
    this.initTime = null;
    this.initialFrame = null;
  }

  _resetAbortSignal() {
    this.abortController = new AbortController();
    this.mainAbortSignal = this.abortController.signal;
  }

  _stopOtherFunctions() {
    const error = new UsercancelledError("User performed a new action");
    this.abortController.abort(error);
    this._resetAbortSignal();
  }

  _getMainAbortSignal() {
    return this.mainAbortSignal;
  }

  abortIfNeeded(promise, debug) {
    return makeMeAbortIfNeeded(promise, this._getMainAbortSignal(), debug);
  }

  updateAlertFunction (new_alert) {
    this.alert = new_alert;
  }
    
  isPlaying() {
    console.debug(this.animationFrameID);
    return this.animationFrameID != null || this.isPlayingMaxSpeed;
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
    console.debug("File", file);
    let videoObjectURL = URL.createObjectURL(file);
    console.debug("url", videoObjectURL);
    await this.abortIfNeeded(this.loadVideoFileFromObjectURL(videoObjectURL, config), "In loadVideoFileFromFile");
    URL.revokeObjectURL(file); // revoke URL to prevent memory leak
  }
  
  // You can pass both object url, or normal url like https://leo-colisson.github.io/blenderpoint-web/Demo_24fps.mp4
  async loadVideoFileFromObjectURL(videoObjectURL, userConfig) {
    if (!userConfig) {
      userConfig = {};
    }
    // turn to true when the stops are obtained
    this.isReady = false;
    // If we do not add bind(this), then this will refer to something else
    userConfig._onFinishDemuxer = this._onFinishDemuxer.bind(this);
    userConfig._onConfig = this._onConfig.bind(this);
    this._ensureStoppedAnimationFrame();
    this.currentFrame = 0;
    this.lastDrawnFrame = -1;
    // direction useful to play backward.
    this.playbackSpeed = 1;
    this.isLoadingVideo = true;
    console.debug(videoObjectURL);
    if (this.anyFrame) {
      this.anyFrame.close();
    }
    this.userConfig = userConfig;
    this.userConfig._getMainAbortSignal = this._getMainAbortSignal.bind(this);
    this.anyFrame = new GetAnyFrame(videoObjectURL, userConfig);
  }

  _onConfig(config) {
    // this.mp4boxFile = config.mp4boxFile;
    const jsonComments = this._extractJsonFromVideo(config.mp4boxFile);
    if (jsonComments) {
      try {
        this.jsonComments = JSON.parse(jsonComments);
        console.debug("The video contains the following json: ", this.jsonComments);
        console.debug("userjson", this.userConfig);
        if (this.userConfig.stops) {
          if (typeof this.userConfig.stops === 'string' || this.userConfig.stops instanceof String) {
            this.setStopsFromString(this.userConfig.stops);
          } else {
            this.setStops(this.userConfig.stops);
          }
          console.debug("We got from the configuration the following list of stops:", this.stops);
        } else {
          if (this.jsonComments.stops) {
            this.stops = this.jsonComments.stops;
          } else {
            this.alert("The metadata contains no information about stops: " + jsonComments)
            console.debug(this.jsonComments);
          }
        }
      } catch (e) {
        console.error("Error: could not load the json due to a syntax error " + jsonComments, e);
        this.alert("Error: could not load the json due to a syntax error" + jsonComments);
      }
    } else {
      this.alert("No json in the video, you need to load it manually.");
    }
    console.log("The configuration is done");
    // this.isReady = true;
  }

  
  // extracts the json from the video
  // must be in a meta field like comment, and enclosed between BLENDERPOINTSTART and BLENDERPOINTSTOP
  _extractJsonFromVideo(mp4boxFile) {
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

  async _onFinishDemuxer() {
    this.isReady = true;
    // We draw the first frame
    console.debug("Foo");
    await this.abortIfNeeded(wait(4), "onFinishDemuxer"); // This is needed or the decoder will not get the time to run
    await this.abortIfNeeded(this.gotoFrame(0), "eianlpés");
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
    const aspectRatioFrame = this.anyFrame.getVideoWidth()/this.anyFrame.getVideoHeight();
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
    // console.debug("I will draw the frame", frame);
    this.ctx.drawImage(frame, this.canvas.width/2-w/2, this.canvas.height/2-h/2, w, h);
  }

  // like _drawFrame but takes as argument the index of the frame, and loops with requestAnimationFrame
  // until the frame is loaded if the file is not yet ready to use.
  async _drawFrameFromIndex(i, backward, forceInRange) {
    console.debug("_drawFrameFromIndex", i);
    this._ensureStoppedAnimationFrameFetching();
    if(forceInRange) {
      if (i < 0) {
        i = 0;
      }
      if (i >= this.anyFrame.getNumberOfFramesIfPossible()) {
        i = this.anyFrame.getNumberOfFramesIfPossible() - 1;
      }
    }

    const frame = await this.abortIfNeeded(this.anyFrame.getFrame(i, backward), "tnrstn");
    if (frame) {
      this._drawFrame(frame);
      this.currentFrame = i;
      this.lastDrawnFrame = i;
      this._ensureStoppedAnimationFrameFetching();
      return true;
    } else {
      return false;
    }
  }

  async _gotoFrame(i) {
    console.debug("goto",i);
    this._ensureStoppedAnimationFrame();
    await this.abortIfNeeded(this._drawFrameFromIndex(i, undefined, true), "eiauyd");
    // triggers a refresh
    await this.abortIfNeeded(this.waitRedraw(), "nelelel");
    this._ensureStoppedAnimationFrame();
  }

  async gotoFrame(i) {
    // Make sure to stop existing functions
    this._stopOtherFunctions();
    await this.abortIfNeeded(this._gotoFrame(i), "rrststst");
  }
  
  async gotoPage(i) {
    this._stopOtherFunctions();
    const pages = [...new Set([...this.stops, 0, Infinity])];
    if (i >= pages.length) {
      await this.abortIfNeeded(this._gotoFrame(Infinity), "foofoo");
    } else {
      await this.abortIfNeeded(this._gotoFrame(pages[i]), "foo eianrst");
    }
  }

  getCurrentPage() {
    const pages = [...new Set([...this.stops, 0, Infinity])];
    return pages.filter(e => e <= this.currentFrame).reduce((iMax, x, i, arr) => x > arr[iMax] ? i : iMax, 0);
  }

  getCurrentFrame() {
    return this.currentFrame;
  }
  
  getNumberOfFramesIfPossible() {
    const n = this.anyFrame.getNumberOfFramesIfPossible();
    if (!typeof n === "number") {
      return n;
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

  // call "await this.waitRedraw()" to wait for animationFrame to
  waitRedraw() {
    return new Promise(resolve => {
      this.animationFrameID = requestAnimationFrame(() => {resolve()});
    });
  }

  // play at the max FPS allowed by the screen refresh rate.
  async playAtMaxSpeed() {
    this._stopOtherFunctions();
    // Needed to allow stopping via the toggle play button
    this.isPlayingMaxSpeed = true;
    await this.abortIfNeeded(this._playAtMaxSpeed(), "einarstei");
  }

  // play at the max FPS allowed by the screen refresh rate.
  async _playAtMaxSpeed() {
    console.debug("Playing max speed", this.isPlayingMaxSpeed);
    if (!this.isPlayingMaxSpeed) {
      console.debug("Finished to draw, stopped by user.");
      this._ensureStoppedAnimationFrame();
      return;
    }
    const nextFrame = this.currentFrame + 1;
    const notTheLastOne = await this.abortIfNeeded(this._drawFrameFromIndex(nextFrame), "xxxxxx");
    if(notTheLastOne) {
      await this.abortIfNeeded(this.waitRedraw(), "wreiastr");
      await this.abortIfNeeded(this._playAtMaxSpeed(), "eiuarnst");
    }
    else {
      this.isPlayingMaxSpeed = false;
      console.debug("Finished to draw");
      this._ensureStoppedAnimationFrame();
    }
  }

  
  // frame is optional, return the next stop. It might return Infinity if there is none
  getNextStop(frame) {
    const initialFrame = frame || this.currentFrame;
    console.debug(this.stops);
    console.debug(initialFrame)
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
    console.debug("I am starting playUntilNextStop");
    this._stopOtherFunctions();
    // If we click while playing, we jump to the stop directly:
    console.debug("called playuntil");
    if (!this.isReady) {
      console.debug("The file is not yet ready, wait a bit more.");
      return
    }
    if (this.isPlayingUntil != undefined) {
      console.debug("I am playing until");
      await this.abortIfNeeded(this._gotoFrame(this.isPlayingUntil), "nrststs");
      return
    }
    if (this.isPlayingUntilPrevious != undefined) {
      console.debug("I am playing until previous");
      await this.abortIfNeeded(this._gotoFrame(this.currentFrame), "ssss");
      return
    }
    console.debug("We were apparently not playing");
    // We first compute the next stop
    this.initialFrame = this.currentFrame;
    const nextStop = stop || this.getNextStop();
    console.debug(nextStop, stop);
    // https://stackoverflow.com/questions/30795525/performance-now-vs-date-now
    this.initTime = performance.now();
    this.isPlayingUntil = nextStop;
    const playAux = async () => {
      const deltaTime = (performance.now() - this.initTime)/1000;
      var frameToDisplay = Math.min(Math.round(deltaTime * this.fps * this.playbackSpeed) + this.initialFrame, nextStop);
      console.debug("frameToDisplay", frameToDisplay);
      // To check if a frame jump were supposed to happend.
      var frameJump = false;
      // If we were supposed to jump a frame...
      if (frameToDisplay > this.currentFrame+1) {
        // ... well we don't jump and reinitialize the time. Otherwise, if we jump it could create huge
        // ugly jumps, even if the decoder is only slightly too slow.
        console.debug("jump: We were supposed to have a frame jump, from ", this.currentFrame, " to ", frameToDisplay);
        frameToDisplay = this.currentFrame+1;
        frameJump = true;
        console.debug("jump: so instead we will draw ", frameToDisplay);
      }
      const notTheLastOne = await this.abortIfNeeded(this._drawFrameFromIndex(frameToDisplay), "meriuast");
      if (frameJump) {
        this.initTime = performance.now();
        this.initialFrame = frameToDisplay;
      }
      if(notTheLastOne && frameToDisplay < nextStop) {
        await this.abortIfNeeded(this.waitRedraw(), "nrstst");
        await this.abortIfNeeded(playAux(), "nsrtsnrt");
      }
      else {
        console.debug("stop", this.stops);
        this.isPlayingUntil = undefined;
        this._ensureStoppedAnimationFrame();
      }
    }
    await this.abortIfNeeded(playAux(), "lieauép");
  }
  
  // nextstop is optional, it will be automatially computed if needed. Set to Infinity if you want to play until the end.
  async playUntilPreviousStop(stop) {
    this._stopOtherFunctions();
    if (!this.isReady) {
      console.debug("The file is not yet ready, wait a bit more.");
      return
    }
    // If we click while playing, we jump to the stop directly:
    console.debug("called playuntilprevious");
    if (this.isPlayingUntilPrevious != undefined) {
      await this.abortIfNeeded(this._gotoFrame(this.isPlayingUntilPrevious), "nerstnrst");
      return
    }
    // if we were playing forward, we stop here
    if (this.isPlayingUntil != undefined) {
      await this.abortIfNeeded(this._gotoFrame(this.currentFrame), "dpdpdpd");
      return
    }
    // First stop the play
    this._ensureStoppedAnimationFrame()
    // We first compute the next stop
    this.initialFrame = this.currentFrame;
    const nextStop = stop || this.getPreviousStop();
    console.debug("Will play until ", nextStop);
    this.initTime = performance.now();
    console.debug(nextStop);
    this.isPlayingUntilPrevious = nextStop;
    const playAux = async () => {
      const deltaTime = (performance.now() - this.initTime)/1000;
      console.debug(deltaTime, this.fps, this.playbackSpeed, this.initialFrame, nextStop);
      var frameToDisplay = Math.max(-Math.round(deltaTime * this.fps * this.playbackSpeed) + this.initialFrame, nextStop);
      // To check if a frame jump were supposed to happend.
      var frameJump = false;
      // If we were supposed to jump a frame...
      if (frameToDisplay < this.currentFrame-1) {
        // ... well we don't jump and reinitialize the time. Otherwise, if we jump it could create huge
        // ugly jumps, even if the decoder is only slightly too slow.
        console.debug("jump: We were supposed to have a frame jump, from ", this.currentFrame, " to ", frameToDisplay);
        frameToDisplay = this.currentFrame-1;
        frameJump = true;
        console.debug("jump: so instead we will draw ", frameToDisplay);
      }

      const notTheLastOne = await this.abortIfNeeded(this._drawFrameFromIndex(frameToDisplay, true), "seseses");
      if (frameJump) {
        this.initTime = performance.now();
        this.initialFrame = frameToDisplay;
      }
      if(notTheLastOne && frameToDisplay > nextStop) {
        await this.abortIfNeeded(this.waitRedraw(), "nrst");
        await this.abortIfNeeded(playAux(), "ssediuatdlt");
      }
      else {
        console.debug("stop");
        this.isPlayingUntilPrevious = undefined;
        this._ensureStoppedAnimationFrame();
      }
    }
    await this.abortIfNeeded(playAux(), "nrsteuid");
  }

  
  // stop is optional, it will be automatially computed
  async gotoPreviousStop(stop) {
    this._stopOtherFunctions();
    if (!this.isReady) {
      console.debug("The file is not yet ready, wait a bit more.");
      return
    }
    // First stop the play
    this._ensureStoppedAnimationFrame();
    const previousStop = stop || this.getPreviousStop();
    return await this.abortIfNeeded(this._gotoFrame(previousStop, true, true), "nrstnr");
  }

  async gotoPreviousFrame() {
    this._stopOtherFunctions();
    await this.abortIfNeeded(this._gotoFrame(this.currentFrame - 1, true, true), "eiudid");
  }

  async gotoNextFrame() {
    this._stopOtherFunctions();
    await this.abortIfNeeded(this._gotoFrame(this.currentFrame + 1), "eatldits");
  }


  async pause() {
    this._stopOtherFunctions();
    this._ensureStoppedAnimationFrame();
  }

  async togglePlayPause() {
    if (this.isPlaying()) {
      if(this.isPlayingMaxSpeed) {
        this.isPlayingMaxSpeed = false;
      }
      this._ensureStoppedAnimationFrame();
    } else {
      await this.playUntilNextStop(Infinity)
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
      await this.abortIfNeeded(this._drawFrameFromIndex(this.currentFrame), "eisisiss");
      await this.abortIfNeeded(this.waitRedraw(), "tzelleds");
      this._ensureStoppedAnimationFrame(); // otherwise it thinks that it is still playing.
      console.debug("we are not playing")
    } else {
      console.debug("we are playing")
    }
  }


  close() {
    this.anyFrame.close();
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

  logGlobal() {
    var message = "\nAll stops: " + this.stops;
    this.frameLog(message);
  }

  async action(actionType, actionData, actionID) {
    try {
      switch (actionType) {
        case 'loadVideoFileFromObjectURL':
          console.debug("userconfig action", actionData.config);
          await this.loadVideoFileFromObjectURL(actionData.videoObjectURL, actionData.config);
          break;
        case 'playUntilNextStop':
          await this.playUntilNextStop();
          break;
        case 'playUntilPreviousStop':
          await this.playUntilPreviousStop();
          break;
        case 'togglePlayPause':
          await this.togglePlayPause();
          break;
        case 'gotoNextFrame':
          await this.gotoNextFrame();
          break;
        case 'gotoPreviousFrame':
          await this.gotoPreviousFrame();
          break;
        case 'gotoPreviousStop':
          await this.gotoPreviousStop(actionData);
          break;
        case 'pause':
          await this.pause();
          break;
        case 'playAtMaxSpeed':
          await this.playAtMaxSpeed();
          break;
        case 'gotoFrame':
          await this.gotoFrame(actionData);
          break;
        case 'gotoPage':
          await this.gotoPage(actionData);
          break;
        case 'logFrame':
          await this.logFrame(actionData === undefined ? this.currentFrame : actionData);
          break;
        case 'logGlobal':
          await this.logGlobal();
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
          self.postMessage({actionID: actionID, result: this.getStops()});
          break;
        case 'getCurrentPage':
          self.postMessage({actionID: actionID, result: this.getCurrentPage()});
          break;
        case 'getCurrentFrame':
          self.postMessage({actionID: actionID, result: this.getCurrentFrame()});
          break;
        case 'getNumberOfPages':
          console.debug("actionID", actionID);
          const nbPages = this.getNumberOfPages();
          self.postMessage({actionID: actionID, result: nbPages});
          break;
        case 'getNumberOfFramesIfPossible':
          self.postMessage({actionID: actionID, result: this.getNumberOfFramesIfPossible()});
          break;
        case 'getInfoOnFrame':
          self.postMessage({actionID: actionID, result: this.getInfoOnFrame(actionData)});
          break;
        case 'loadVideoFileFromFile':
          await this.loadVideoFileFromFile(actionData.file, actionData.config);
          break;
        case 'redrawWhenResolutionChanges':
          await this.redrawWhenResolutionChanges();
          break;
        case 'restoreCanvasSize':
          await this.restoreCanvasSize();
          break;
        case 'canvasChangeSize':
          await this.canvasChangeSize(actionData.width, actionData.height);
          break;
        case 'close':
          await this.close();
          break;
        case 'setFps':
          await this.setFps(actionData)
          break;
      }
    } catch (error) {
      console.log("catch: We just got error", error);
      // We do not want to display errors for the error we get when the user pressed twice a given key
      if (!(error instanceof UsercancelledError)) {
        throw error;
      }
    }
    console.debug("catch: We finished the function");
  }
}

self.bpVideo = null;
// Catch asynchronous errors
// https://developer.mozilla.org/en-US/docs/Web/API/Window/unhandledrejection_event
self.onunhandledrejection = function (event) {
  if(event.reason instanceof UsercancelledError) {
    event.preventDefault();
  }
};
self.onerror = function (event) {
  if(event.reason instanceof UsercancelledError) {
    event.preventDefault();
  }
};
self.onmessage = function(msg) {
  if (msg.data.canvas) {
    console.log("Hey from worker!");
    const config = msg.data.config || {};
    self.bpVideo = new BlenderpointVideoWorker(msg.data.canvas, config);
  }
  if (msg.data.blenderpointActionType) {
    if (self.bpVideo) {
      bpVideo.action(msg.data.blenderpointActionType, msg.data.blenderpointActionData, msg.data.actionID);
    } else {
      self.postMessage({error: "You must first load a video before interacting with it."});
    }
  }
}

/*! mp4box 23-09-2022 */
var Log=function(){var i=new Date,r=4;return{setLogLevel:function(t){r=t==this.debug?1:t==this.info?2:t==this.warn?3:(this.error,4)},debug:function(t,e){void 0===console.debug&&(console.debug=console.log),r<=1&&console.debug("["+Log.getDurationString(new Date-i,1e3)+"]","["+t+"]",e)},log:function(t,e){this.debug(t.msg)},info:function(t,e){r<=2&&console.info("["+Log.getDurationString(new Date-i,1e3)+"]","["+t+"]",e)},warn:function(t,e){r<=3&&console.warn("["+Log.getDurationString(new Date-i,1e3)+"]","["+t+"]",e)},error:function(t,e){r<=4&&console.error("["+Log.getDurationString(new Date-i,1e3)+"]","["+t+"]",e)}}}();Log.getDurationString=function(t,e){var i;function r(t,e){for(var i=(""+t).split(".");i[0].length<e;)i[0]="0"+i[0];return i.join(".")}t<0?(i=!0,t=-t):i=!1;var s=t/(e||1),a=Math.floor(s/3600);s-=3600*a;t=Math.floor(s/60),e=1e3*(s-=60*t);return e-=1e3*(s=Math.floor(s)),e=Math.floor(e),(i?"-":"")+a+":"+r(t,2)+":"+r(s,2)+"."+r(e,3)},Log.printRanges=function(t){var e=t.length;if(0<e){for(var i="",r=0;r<e;r++)0<r&&(i+=","),i+="["+Log.getDurationString(t.start(r))+","+Log.getDurationString(t.end(r))+"]";return i}return"(empty)"},"undefined"!=typeof exports&&(exports.Log=Log);var MP4BoxStream=function(t){if(!(t instanceof ArrayBuffer))throw"Needs an array buffer";this.buffer=t,this.dataview=new DataView(t),this.position=0};MP4BoxStream.prototype.getPosition=function(){return this.position},MP4BoxStream.prototype.getEndPosition=function(){return this.buffer.byteLength},MP4BoxStream.prototype.getLength=function(){return this.buffer.byteLength},MP4BoxStream.prototype.seek=function(t){t=Math.max(0,Math.min(this.buffer.byteLength,t));return this.position=isNaN(t)||!isFinite(t)?0:t,!0},MP4BoxStream.prototype.isEos=function(){return this.getPosition()>=this.getEndPosition()},MP4BoxStream.prototype.readAnyInt=function(t,e){var i=0;if(this.position+t<=this.buffer.byteLength){switch(t){case 1:i=e?this.dataview.getInt8(this.position):this.dataview.getUint8(this.position);break;case 2:i=e?this.dataview.getInt16(this.position):this.dataview.getUint16(this.position);break;case 3:if(e)throw"No method for reading signed 24 bits values";i=this.dataview.getUint8(this.position)<<16,i|=this.dataview.getUint8(this.position+1)<<8,i|=this.dataview.getUint8(this.position+2);break;case 4:i=e?this.dataview.getInt32(this.position):this.dataview.getUint32(this.position);break;case 8:if(e)throw"No method for reading signed 64 bits values";i=this.dataview.getUint32(this.position)<<32,i|=this.dataview.getUint32(this.position+4);break;default:throw"readInt method not implemented for size: "+t}return this.position+=t,i}throw"Not enough bytes in buffer"},MP4BoxStream.prototype.readUint8=function(){return this.readAnyInt(1,!1)},MP4BoxStream.prototype.readUint16=function(){return this.readAnyInt(2,!1)},MP4BoxStream.prototype.readUint24=function(){return this.readAnyInt(3,!1)},MP4BoxStream.prototype.readUint32=function(){return this.readAnyInt(4,!1)},MP4BoxStream.prototype.readUint64=function(){return this.readAnyInt(8,!1)},MP4BoxStream.prototype.readString=function(t){if(this.position+t<=this.buffer.byteLength){for(var e="",i=0;i<t;i++)e+=String.fromCharCode(this.readUint8());return e}throw"Not enough bytes in buffer"},MP4BoxStream.prototype.readCString=function(){for(var t=[];;){var e=this.readUint8();if(0===e)break;t.push(e)}return String.fromCharCode.apply(null,t)},MP4BoxStream.prototype.readInt8=function(){return this.readAnyInt(1,!0)},MP4BoxStream.prototype.readInt16=function(){return this.readAnyInt(2,!0)},MP4BoxStream.prototype.readInt32=function(){return this.readAnyInt(4,!0)},MP4BoxStream.prototype.readInt64=function(){return this.readAnyInt(8,!1)},MP4BoxStream.prototype.readUint8Array=function(t){for(var e=new Uint8Array(t),i=0;i<t;i++)e[i]=this.readUint8();return e},MP4BoxStream.prototype.readInt16Array=function(t){for(var e=new Int16Array(t),i=0;i<t;i++)e[i]=this.readInt16();return e},MP4BoxStream.prototype.readUint16Array=function(t){for(var e=new Int16Array(t),i=0;i<t;i++)e[i]=this.readUint16();return e},MP4BoxStream.prototype.readUint32Array=function(t){for(var e=new Uint32Array(t),i=0;i<t;i++)e[i]=this.readUint32();return e},MP4BoxStream.prototype.readInt32Array=function(t){for(var e=new Int32Array(t),i=0;i<t;i++)e[i]=this.readInt32();return e},"undefined"!=typeof exports&&(exports.MP4BoxStream=MP4BoxStream);var DataStream=function(t,e,i){this._byteOffset=e||0,t instanceof ArrayBuffer?this.buffer=t:"object"==typeof t?(this.dataView=t,e&&(this._byteOffset+=e)):this.buffer=new ArrayBuffer(t||0),this.position=0,this.endianness=null==i?DataStream.LITTLE_ENDIAN:i};DataStream.prototype={},DataStream.prototype.getPosition=function(){return this.position},DataStream.prototype._realloc=function(t){if(this._dynamicSize){var e=this._byteOffset+this.position+t,i=this._buffer.byteLength;if(e<=i)e>this._byteLength&&(this._byteLength=e);else{for(i<1&&(i=1);i<e;)i*=2;var r=new ArrayBuffer(i),t=new Uint8Array(this._buffer);new Uint8Array(r,0,t.length).set(t),this.buffer=r,this._byteLength=e}}},DataStream.prototype._trimAlloc=function(){var t,e,i;this._byteLength!=this._buffer.byteLength&&(t=new ArrayBuffer(this._byteLength),e=new Uint8Array(t),i=new Uint8Array(this._buffer,0,e.length),e.set(i),this.buffer=t)},DataStream.BIG_ENDIAN=!1,DataStream.LITTLE_ENDIAN=!0,DataStream.prototype._byteLength=0,Object.defineProperty(DataStream.prototype,"byteLength",{get:function(){return this._byteLength-this._byteOffset}}),Object.defineProperty(DataStream.prototype,"buffer",{get:function(){return this._trimAlloc(),this._buffer},set:function(t){this._buffer=t,this._dataView=new DataView(this._buffer,this._byteOffset),this._byteLength=this._buffer.byteLength}}),Object.defineProperty(DataStream.prototype,"byteOffset",{get:function(){return this._byteOffset},set:function(t){this._byteOffset=t,this._dataView=new DataView(this._buffer,this._byteOffset),this._byteLength=this._buffer.byteLength}}),Object.defineProperty(DataStream.prototype,"dataView",{get:function(){return this._dataView},set:function(t){this._byteOffset=t.byteOffset,this._buffer=t.buffer,this._dataView=new DataView(this._buffer,this._byteOffset),this._byteLength=this._byteOffset+t.byteLength}}),DataStream.prototype.seek=function(t){t=Math.max(0,Math.min(this.byteLength,t));this.position=isNaN(t)||!isFinite(t)?0:t},DataStream.prototype.isEof=function(){return this.position>=this._byteLength},DataStream.prototype.mapUint8Array=function(t){this._realloc(+t);var e=new Uint8Array(this._buffer,this.byteOffset+this.position,t);return this.position+=+t,e},DataStream.prototype.readInt32Array=function(t,e){t=null==t?this.byteLength-this.position/4:t;var i=new Int32Array(t);return DataStream.memcpy(i.buffer,0,this.buffer,this.byteOffset+this.position,t*i.BYTES_PER_ELEMENT),DataStream.arrayToNative(i,null==e?this.endianness:e),this.position+=i.byteLength,i},DataStream.prototype.readInt16Array=function(t,e){t=null==t?this.byteLength-this.position/2:t;var i=new Int16Array(t);return DataStream.memcpy(i.buffer,0,this.buffer,this.byteOffset+this.position,t*i.BYTES_PER_ELEMENT),DataStream.arrayToNative(i,null==e?this.endianness:e),this.position+=i.byteLength,i},DataStream.prototype.readInt8Array=function(t){t=null==t?this.byteLength-this.position:t;var e=new Int8Array(t);return DataStream.memcpy(e.buffer,0,this.buffer,this.byteOffset+this.position,t*e.BYTES_PER_ELEMENT),this.position+=e.byteLength,e},DataStream.prototype.readUint32Array=function(t,e){t=null==t?this.byteLength-this.position/4:t;var i=new Uint32Array(t);return DataStream.memcpy(i.buffer,0,this.buffer,this.byteOffset+this.position,t*i.BYTES_PER_ELEMENT),DataStream.arrayToNative(i,null==e?this.endianness:e),this.position+=i.byteLength,i},DataStream.prototype.readUint16Array=function(t,e){t=null==t?this.byteLength-this.position/2:t;var i=new Uint16Array(t);return DataStream.memcpy(i.buffer,0,this.buffer,this.byteOffset+this.position,t*i.BYTES_PER_ELEMENT),DataStream.arrayToNative(i,null==e?this.endianness:e),this.position+=i.byteLength,i},DataStream.prototype.readUint8Array=function(t){t=null==t?this.byteLength-this.position:t;var e=new Uint8Array(t);return DataStream.memcpy(e.buffer,0,this.buffer,this.byteOffset+this.position,t*e.BYTES_PER_ELEMENT),this.position+=e.byteLength,e},DataStream.prototype.readFloat64Array=function(t,e){t=null==t?this.byteLength-this.position/8:t;var i=new Float64Array(t);return DataStream.memcpy(i.buffer,0,this.buffer,this.byteOffset+this.position,t*i.BYTES_PER_ELEMENT),DataStream.arrayToNative(i,null==e?this.endianness:e),this.position+=i.byteLength,i},DataStream.prototype.readFloat32Array=function(t,e){t=null==t?this.byteLength-this.position/4:t;var i=new Float32Array(t);return DataStream.memcpy(i.buffer,0,this.buffer,this.byteOffset+this.position,t*i.BYTES_PER_ELEMENT),DataStream.arrayToNative(i,null==e?this.endianness:e),this.position+=i.byteLength,i},DataStream.prototype.readInt32=function(t){t=this._dataView.getInt32(this.position,null==t?this.endianness:t);return this.position+=4,t},DataStream.prototype.readInt16=function(t){t=this._dataView.getInt16(this.position,null==t?this.endianness:t);return this.position+=2,t},DataStream.prototype.readInt8=function(){var t=this._dataView.getInt8(this.position);return this.position+=1,t},DataStream.prototype.readUint32=function(t){t=this._dataView.getUint32(this.position,null==t?this.endianness:t);return this.position+=4,t},DataStream.prototype.readUint16=function(t){t=this._dataView.getUint16(this.position,null==t?this.endianness:t);return this.position+=2,t},DataStream.prototype.readUint8=function(){var t=this._dataView.getUint8(this.position);return this.position+=1,t},DataStream.prototype.readFloat32=function(t){t=this._dataView.getFloat32(this.position,null==t?this.endianness:t);return this.position+=4,t},DataStream.prototype.readFloat64=function(t){t=this._dataView.getFloat64(this.position,null==t?this.endianness:t);return this.position+=8,t},DataStream.endianness=0<new Int8Array(new Int16Array([1]).buffer)[0],DataStream.memcpy=function(t,e,i,r,s){e=new Uint8Array(t,e,s),s=new Uint8Array(i,r,s);e.set(s)},DataStream.arrayToNative=function(t,e){return e==this.endianness?t:this.flipArrayEndianness(t)},DataStream.nativeToEndian=function(t,e){return this.endianness==e?t:this.flipArrayEndianness(t)},DataStream.flipArrayEndianness=function(t){for(var e=new Uint8Array(t.buffer,t.byteOffset,t.byteLength),i=0;i<t.byteLength;i+=t.BYTES_PER_ELEMENT)for(var r=i+t.BYTES_PER_ELEMENT-1,s=i;s<r;r--,s++){var a=e[s];e[s]=e[r],e[r]=a}return t},DataStream.prototype.failurePosition=0,String.fromCharCodeUint8=function(t){for(var e=[],i=0;i<t.length;i++)e[i]=t[i];return String.fromCharCode.apply(null,e)},DataStream.prototype.readString=function(t,e){return null==e||"ASCII"==e?String.fromCharCodeUint8.apply(null,[this.mapUint8Array(null==t?this.byteLength-this.position:t)]):new TextDecoder(e).decode(this.mapUint8Array(t))},DataStream.prototype.readCString=function(t){var e=this.byteLength-this.position,i=new Uint8Array(this._buffer,this._byteOffset+this.position),r=e;null!=t&&(r=Math.min(t,e));for(var s=0;s<r&&0!==i[s];s++);var a=String.fromCharCodeUint8.apply(null,[this.mapUint8Array(s)]);return null!=t?this.position+=r-s:s!=e&&(this.position+=1),a};var MAX_SIZE=Math.pow(2,32);DataStream.prototype.readInt64=function(){return this.readInt32()*MAX_SIZE+this.readUint32()},DataStream.prototype.readUint64=function(){return this.readUint32()*MAX_SIZE+this.readUint32()},DataStream.prototype.readInt64=function(){return this.readUint32()*MAX_SIZE+this.readUint32()},DataStream.prototype.readUint24=function(){return(this.readUint8()<<16)+(this.readUint8()<<8)+this.readUint8()},"undefined"!=typeof exports&&(exports.DataStream=DataStream),DataStream.prototype.save=function(t){var e=new Blob([this.buffer]);if(!window.URL||!URL.createObjectURL)throw"DataStream.save: Can't create object URL.";var i=window.URL.createObjectURL(e),e=document.createElement("a");document.body.appendChild(e),e.setAttribute("href",i),e.setAttribute("download",t),e.setAttribute("target","_self"),e.click(),window.URL.revokeObjectURL(i)},DataStream.prototype._dynamicSize=!0,Object.defineProperty(DataStream.prototype,"dynamicSize",{get:function(){return this._dynamicSize},set:function(t){t||this._trimAlloc(),this._dynamicSize=t}}),DataStream.prototype.shift=function(t){var e=new ArrayBuffer(this._byteLength-t),i=new Uint8Array(e),r=new Uint8Array(this._buffer,t,i.length);i.set(r),this.buffer=e,this.position-=t},DataStream.prototype.writeInt32Array=function(t,e){if(this._realloc(4*t.length),t instanceof Int32Array&&this.byteOffset+this.position%t.BYTES_PER_ELEMENT===0)DataStream.memcpy(this._buffer,this.byteOffset+this.position,t.buffer,0,t.byteLength),this.mapInt32Array(t.length,e);else for(var i=0;i<t.length;i++)this.writeInt32(t[i],e)},DataStream.prototype.writeInt16Array=function(t,e){if(this._realloc(2*t.length),t instanceof Int16Array&&this.byteOffset+this.position%t.BYTES_PER_ELEMENT===0)DataStream.memcpy(this._buffer,this.byteOffset+this.position,t.buffer,0,t.byteLength),this.mapInt16Array(t.length,e);else for(var i=0;i<t.length;i++)this.writeInt16(t[i],e)},DataStream.prototype.writeInt8Array=function(t){if(this._realloc(+t.length),t instanceof Int8Array&&this.byteOffset+this.position%t.BYTES_PER_ELEMENT===0)DataStream.memcpy(this._buffer,this.byteOffset+this.position,t.buffer,0,t.byteLength),this.mapInt8Array(t.length);else for(var e=0;e<t.length;e++)this.writeInt8(t[e])},DataStream.prototype.writeUint32Array=function(t,e){if(this._realloc(4*t.length),t instanceof Uint32Array&&this.byteOffset+this.position%t.BYTES_PER_ELEMENT===0)DataStream.memcpy(this._buffer,this.byteOffset+this.position,t.buffer,0,t.byteLength),this.mapUint32Array(t.length,e);else for(var i=0;i<t.length;i++)this.writeUint32(t[i],e)},DataStream.prototype.writeUint16Array=function(t,e){if(this._realloc(2*t.length),t instanceof Uint16Array&&this.byteOffset+this.position%t.BYTES_PER_ELEMENT===0)DataStream.memcpy(this._buffer,this.byteOffset+this.position,t.buffer,0,t.byteLength),this.mapUint16Array(t.length,e);else for(var i=0;i<t.length;i++)this.writeUint16(t[i],e)},DataStream.prototype.writeUint8Array=function(t){if(this._realloc(+t.length),t instanceof Uint8Array&&this.byteOffset+this.position%t.BYTES_PER_ELEMENT===0)DataStream.memcpy(this._buffer,this.byteOffset+this.position,t.buffer,0,t.byteLength),this.mapUint8Array(t.length);else for(var e=0;e<t.length;e++)this.writeUint8(t[e])},DataStream.prototype.writeFloat64Array=function(t,e){if(this._realloc(8*t.length),t instanceof Float64Array&&this.byteOffset+this.position%t.BYTES_PER_ELEMENT===0)DataStream.memcpy(this._buffer,this.byteOffset+this.position,t.buffer,0,t.byteLength),this.mapFloat64Array(t.length,e);else for(var i=0;i<t.length;i++)this.writeFloat64(t[i],e)},DataStream.prototype.writeFloat32Array=function(t,e){if(this._realloc(4*t.length),t instanceof Float32Array&&this.byteOffset+this.position%t.BYTES_PER_ELEMENT===0)DataStream.memcpy(this._buffer,this.byteOffset+this.position,t.buffer,0,t.byteLength),this.mapFloat32Array(t.length,e);else for(var i=0;i<t.length;i++)this.writeFloat32(t[i],e)},DataStream.prototype.writeInt32=function(t,e){this._realloc(4),this._dataView.setInt32(this.position,t,null==e?this.endianness:e),this.position+=4},DataStream.prototype.writeInt16=function(t,e){this._realloc(2),this._dataView.setInt16(this.position,t,null==e?this.endianness:e),this.position+=2},DataStream.prototype.writeInt8=function(t){this._realloc(1),this._dataView.setInt8(this.position,t),this.position+=1},DataStream.prototype.writeUint32=function(t,e){this._realloc(4),this._dataView.setUint32(this.position,t,null==e?this.endianness:e),this.position+=4},DataStream.prototype.writeUint16=function(t,e){this._realloc(2),this._dataView.setUint16(this.position,t,null==e?this.endianness:e),this.position+=2},DataStream.prototype.writeUint8=function(t){this._realloc(1),this._dataView.setUint8(this.position,t),this.position+=1},DataStream.prototype.writeFloat32=function(t,e){this._realloc(4),this._dataView.setFloat32(this.position,t,null==e?this.endianness:e),this.position+=4},DataStream.prototype.writeFloat64=function(t,e){this._realloc(8),this._dataView.setFloat64(this.position,t,null==e?this.endianness:e),this.position+=8},DataStream.prototype.writeUCS2String=function(t,e,i){null==i&&(i=t.length);for(var r=0;r<t.length&&r<i;r++)this.writeUint16(t.charCodeAt(r),e);for(;r<i;r++)this.writeUint16(0)},DataStream.prototype.writeString=function(t,e,i){var r=0;if(null==e||"ASCII"==e)if(null!=i){for(var s=Math.min(t.length,i),r=0;r<s;r++)this.writeUint8(t.charCodeAt(r));for(;r<i;r++)this.writeUint8(0)}else for(r=0;r<t.length;r++)this.writeUint8(t.charCodeAt(r));else this.writeUint8Array(new TextEncoder(e).encode(t.substring(0,i)))},DataStream.prototype.writeCString=function(t,e){var i=0;if(null!=e){for(var r=Math.min(t.length,e),i=0;i<r;i++)this.writeUint8(t.charCodeAt(i));for(;i<e;i++)this.writeUint8(0)}else{for(i=0;i<t.length;i++)this.writeUint8(t.charCodeAt(i));this.writeUint8(0)}},DataStream.prototype.writeStruct=function(t,e){for(var i=0;i<t.length;i+=2){var r=t[i+1];this.writeType(r,e[t[i]],e)}},DataStream.prototype.writeType=function(t,e,i){var r;if("function"==typeof t)return t(this,e);if("object"==typeof t&&!(t instanceof Array))return t.set(this,e,i);var s=null,a="ASCII",i=this.position;switch("string"==typeof t&&/:/.test(t)&&(t=(r=t.split(":"))[0],s=parseInt(r[1])),"string"==typeof t&&/,/.test(t)&&(t=(r=t.split(","))[0],a=parseInt(r[1])),t){case"uint8":this.writeUint8(e);break;case"int8":this.writeInt8(e);break;case"uint16":this.writeUint16(e,this.endianness);break;case"int16":this.writeInt16(e,this.endianness);break;case"uint32":this.writeUint32(e,this.endianness);break;case"int32":this.writeInt32(e,this.endianness);break;case"float32":this.writeFloat32(e,this.endianness);break;case"float64":this.writeFloat64(e,this.endianness);break;case"uint16be":this.writeUint16(e,DataStream.BIG_ENDIAN);break;case"int16be":this.writeInt16(e,DataStream.BIG_ENDIAN);break;case"uint32be":this.writeUint32(e,DataStream.BIG_ENDIAN);break;case"int32be":this.writeInt32(e,DataStream.BIG_ENDIAN);break;case"float32be":this.writeFloat32(e,DataStream.BIG_ENDIAN);break;case"float64be":this.writeFloat64(e,DataStream.BIG_ENDIAN);break;case"uint16le":this.writeUint16(e,DataStream.LITTLE_ENDIAN);break;case"int16le":this.writeInt16(e,DataStream.LITTLE_ENDIAN);break;case"uint32le":this.writeUint32(e,DataStream.LITTLE_ENDIAN);break;case"int32le":this.writeInt32(e,DataStream.LITTLE_ENDIAN);break;case"float32le":this.writeFloat32(e,DataStream.LITTLE_ENDIAN);break;case"float64le":this.writeFloat64(e,DataStream.LITTLE_ENDIAN);break;case"cstring":this.writeCString(e,s);break;case"string":this.writeString(e,a,s);break;case"u16string":this.writeUCS2String(e,this.endianness,s);break;case"u16stringle":this.writeUCS2String(e,DataStream.LITTLE_ENDIAN,s);break;case"u16stringbe":this.writeUCS2String(e,DataStream.BIG_ENDIAN,s);break;default:if(3==t.length){for(var n=t[1],o=0;o<e.length;o++)this.writeType(n,e[o]);break}this.writeStruct(t,e)}null!=s&&(this.position=i,this._realloc(s),this.position=i+s)},DataStream.prototype.writeUint64=function(t){var e=Math.floor(t/MAX_SIZE);this.writeUint32(e),this.writeUint32(4294967295&t)},DataStream.prototype.writeUint24=function(t){this.writeUint8((16711680&t)>>16),this.writeUint8((65280&t)>>8),this.writeUint8(255&t)},DataStream.prototype.adjustUint32=function(t,e){var i=this.position;this.seek(t),this.writeUint32(e),this.seek(i)},DataStream.prototype.mapInt32Array=function(t,e){this._realloc(4*t);var i=new Int32Array(this._buffer,this.byteOffset+this.position,t);return DataStream.arrayToNative(i,null==e?this.endianness:e),this.position+=4*t,i},DataStream.prototype.mapInt16Array=function(t,e){this._realloc(2*t);var i=new Int16Array(this._buffer,this.byteOffset+this.position,t);return DataStream.arrayToNative(i,null==e?this.endianness:e),this.position+=2*t,i},DataStream.prototype.mapInt8Array=function(t){this._realloc(+t);var e=new Int8Array(this._buffer,this.byteOffset+this.position,t);return this.position+=+t,e},DataStream.prototype.mapUint32Array=function(t,e){this._realloc(4*t);var i=new Uint32Array(this._buffer,this.byteOffset+this.position,t);return DataStream.arrayToNative(i,null==e?this.endianness:e),this.position+=4*t,i},DataStream.prototype.mapUint16Array=function(t,e){this._realloc(2*t);var i=new Uint16Array(this._buffer,this.byteOffset+this.position,t);return DataStream.arrayToNative(i,null==e?this.endianness:e),this.position+=2*t,i},DataStream.prototype.mapFloat64Array=function(t,e){this._realloc(8*t);var i=new Float64Array(this._buffer,this.byteOffset+this.position,t);return DataStream.arrayToNative(i,null==e?this.endianness:e),this.position+=8*t,i},DataStream.prototype.mapFloat32Array=function(t,e){this._realloc(4*t);var i=new Float32Array(this._buffer,this.byteOffset+this.position,t);return DataStream.arrayToNative(i,null==e?this.endianness:e),this.position+=4*t,i};var MultiBufferStream=function(t){this.buffers=[],this.bufferIndex=-1,t&&(this.insertBuffer(t),this.bufferIndex=0)};MultiBufferStream.prototype=new DataStream(new ArrayBuffer,0,DataStream.BIG_ENDIAN),MultiBufferStream.prototype.initialized=function(){var t;return-1<this.bufferIndex||(0<this.buffers.length?0===(t=this.buffers[0]).fileStart?(this.buffer=t,this.bufferIndex=0,Log.debug("MultiBufferStream","Stream ready for parsing"),!0):(Log.warn("MultiBufferStream","The first buffer should have a fileStart of 0"),this.logBufferLevel(),!1):(Log.warn("MultiBufferStream","No buffer to start parsing from"),this.logBufferLevel(),!1))},ArrayBuffer.concat=function(t,e){Log.debug("ArrayBuffer","Trying to create a new buffer of size: "+(t.byteLength+e.byteLength));var i=new Uint8Array(t.byteLength+e.byteLength);return i.set(new Uint8Array(t),0),i.set(new Uint8Array(e),t.byteLength),i.buffer},MultiBufferStream.prototype.reduceBuffer=function(t,e,i){var r=new Uint8Array(i);return r.set(new Uint8Array(t,e,i)),r.buffer.fileStart=t.fileStart+e,r.buffer.usedBytes=0,r.buffer},MultiBufferStream.prototype.insertBuffer=function(t){for(var e=!0,i=0;i<this.buffers.length;i++){var r=this.buffers[i];if(t.fileStart<=r.fileStart){if(t.fileStart===r.fileStart){if(t.byteLength>r.byteLength){this.buffers.splice(i,1),i--;continue}Log.warn("MultiBufferStream","Buffer (fileStart: "+t.fileStart+" - Length: "+t.byteLength+") already appended, ignoring")}else t.fileStart+t.byteLength<=r.fileStart||(t=this.reduceBuffer(t,0,r.fileStart-t.fileStart)),Log.debug("MultiBufferStream","Appending new buffer (fileStart: "+t.fileStart+" - Length: "+t.byteLength+")"),this.buffers.splice(i,0,t),0===i&&(this.buffer=t);e=!1;break}if(t.fileStart<r.fileStart+r.byteLength){var s=r.fileStart+r.byteLength-t.fileStart,r=t.byteLength-s;if(!(0<r)){e=!1;break}t=this.reduceBuffer(t,s,r)}}e&&(Log.debug("MultiBufferStream","Appending new buffer (fileStart: "+t.fileStart+" - Length: "+t.byteLength+")"),this.buffers.push(t),0===i&&(this.buffer=t))},MultiBufferStream.prototype.logBufferLevel=function(t){for(var e,i,r=[],s="",a=0,n=0,o=0;o<this.buffers.length;o++)e=this.buffers[o],0===o?(i={},r.push(i),i.start=e.fileStart,i.end=e.fileStart+e.byteLength,s+="["+i.start+"-"):i.end===e.fileStart?i.end=e.fileStart+e.byteLength:((i={}).start=e.fileStart,s+=r[r.length-1].end-1+"], ["+i.start+"-",i.end=e.fileStart+e.byteLength,r.push(i)),a+=e.usedBytes,n+=e.byteLength;0<r.length&&(s+=i.end-1+"]");t=t?Log.info:Log.debug;0===this.buffers.length?t("MultiBufferStream","No more buffer in memory"):t("MultiBufferStream",this.buffers.length+" stored buffer(s) ("+a+"/"+n+" bytes), continuous ranges: "+s)},MultiBufferStream.prototype.cleanBuffers=function(){for(var t,e=0;e<this.buffers.length;e++)(t=this.buffers[e]).usedBytes===t.byteLength&&(Log.debug("MultiBufferStream","Removing buffer #"+e),this.buffers.splice(e,1),e--)},MultiBufferStream.prototype.mergeNextBuffer=function(){var t;if(this.bufferIndex+1<this.buffers.length){if((t=this.buffers[this.bufferIndex+1]).fileStart!==this.buffer.fileStart+this.buffer.byteLength)return!1;var e=this.buffer.byteLength,i=this.buffer.usedBytes,r=this.buffer.fileStart;return this.buffers[this.bufferIndex]=ArrayBuffer.concat(this.buffer,t),this.buffer=this.buffers[this.bufferIndex],this.buffers.splice(this.bufferIndex+1,1),this.buffer.usedBytes=i,this.buffer.fileStart=r,Log.debug("ISOFile","Concatenating buffer for box parsing (length: "+e+"->"+this.buffer.byteLength+")"),!0}return!1},MultiBufferStream.prototype.findPosition=function(t,e,i){for(var r=null,s=-1,a=!0===t?0:this.bufferIndex;a<this.buffers.length&&(r=this.buffers[a]).fileStart<=e;)s=a,i&&(r.fileStart+r.byteLength<=e?r.usedBytes=r.byteLength:r.usedBytes=e-r.fileStart,this.logBufferLevel()),a++;return-1!==s&&(r=this.buffers[s]).fileStart+r.byteLength>=e?(Log.debug("MultiBufferStream","Found position in existing buffer #"+s),s):-1},MultiBufferStream.prototype.findEndContiguousBuf=function(t){var e,i,t=void 0!==t?t:this.bufferIndex,r=this.buffers[t];if(this.buffers.length>t+1)for(e=t+1;e<this.buffers.length&&(i=this.buffers[e]).fileStart===r.fileStart+r.byteLength;e++)r=i;return r.fileStart+r.byteLength},MultiBufferStream.prototype.getEndFilePositionAfter=function(t){var e=this.findPosition(!0,t,!1);return-1!==e?this.findEndContiguousBuf(e):t},MultiBufferStream.prototype.addUsedBytes=function(t){this.buffer.usedBytes+=t,this.logBufferLevel()},MultiBufferStream.prototype.setAllUsedBytes=function(){this.buffer.usedBytes=this.buffer.byteLength,this.logBufferLevel()},MultiBufferStream.prototype.seek=function(t,e,i){i=this.findPosition(e,t,i);return-1!==i?(this.buffer=this.buffers[i],this.bufferIndex=i,this.position=t-this.buffer.fileStart,Log.debug("MultiBufferStream","Repositioning parser at buffer position: "+this.position),!0):(Log.debug("MultiBufferStream","Position "+t+" not found in buffered data"),!1)},MultiBufferStream.prototype.getPosition=function(){if(-1===this.bufferIndex||null===this.buffers[this.bufferIndex])throw"Error accessing position in the MultiBufferStream";return this.buffers[this.bufferIndex].fileStart+this.position},MultiBufferStream.prototype.getLength=function(){return this.byteLength},MultiBufferStream.prototype.getEndPosition=function(){if(-1===this.bufferIndex||null===this.buffers[this.bufferIndex])throw"Error accessing position in the MultiBufferStream";return this.buffers[this.bufferIndex].fileStart+this.byteLength},"undefined"!=typeof exports&&(exports.MultiBufferStream=MultiBufferStream);var MPEG4DescriptorParser=function(){var s=[];s[3]="ES_Descriptor",s[4]="DecoderConfigDescriptor",s[5]="DecoderSpecificInfo",s[6]="SLConfigDescriptor",this.getDescriptorName=function(t){return s[t]};var r=this,a={};return this.parseOneDescriptor=function(t){var e,i=0,r=t.readUint8();for(e=t.readUint8(),0;128&e;)i=(127&e)<<7,e=t.readUint8(),0;return i+=127&e,Log.debug("MPEG4DescriptorParser","Found "+(s[r]||"Descriptor "+r)+", size "+i+" at position "+t.getPosition()),(r=new(s[r]?a[s[r]]:a.Descriptor)(i)).parse(t),r},a.Descriptor=function(t,e){this.tag=t,this.size=e,this.descs=[]},a.Descriptor.prototype.parse=function(t){this.data=t.readUint8Array(this.size)},a.Descriptor.prototype.findDescriptor=function(t){for(var e=0;e<this.descs.length;e++)if(this.descs[e].tag==t)return this.descs[e];return null},a.Descriptor.prototype.parseRemainingDescriptors=function(t){for(var e=t.position;t.position<e+this.size;){var i=r.parseOneDescriptor(t);this.descs.push(i)}},a.ES_Descriptor=function(t){a.Descriptor.call(this,3,t)},a.ES_Descriptor.prototype=new a.Descriptor,a.ES_Descriptor.prototype.parse=function(t){var e;this.ES_ID=t.readUint16(),this.flags=t.readUint8(),this.size-=3,128&this.flags?(this.dependsOn_ES_ID=t.readUint16(),this.size-=2):this.dependsOn_ES_ID=0,64&this.flags?(e=t.readUint8(),this.URL=t.readString(e),this.size-=e+1):this.URL="",32&this.flags?(this.OCR_ES_ID=t.readUint16(),this.size-=2):this.OCR_ES_ID=0,this.parseRemainingDescriptors(t)},a.ES_Descriptor.prototype.getOTI=function(t){var e=this.findDescriptor(4);return e?e.oti:0},a.ES_Descriptor.prototype.getAudioConfig=function(t){var e=this.findDescriptor(4);if(!e)return null;var i=e.findDescriptor(5);if(i&&i.data){e=(248&i.data[0])>>3;return 31===e&&2<=i.data.length&&(e=32+((7&i.data[0])<<3)+((224&i.data[1])>>5)),e}return null},a.DecoderConfigDescriptor=function(t){a.Descriptor.call(this,4,t)},a.DecoderConfigDescriptor.prototype=new a.Descriptor,a.DecoderConfigDescriptor.prototype.parse=function(t){this.oti=t.readUint8(),this.streamType=t.readUint8(),this.bufferSize=t.readUint24(),this.maxBitrate=t.readUint32(),this.avgBitrate=t.readUint32(),this.size-=13,this.parseRemainingDescriptors(t)},a.DecoderSpecificInfo=function(t){a.Descriptor.call(this,5,t)},a.DecoderSpecificInfo.prototype=new a.Descriptor,a.SLConfigDescriptor=function(t){a.Descriptor.call(this,6,t)},a.SLConfigDescriptor.prototype=new a.Descriptor,this};"undefined"!=typeof exports&&(exports.MPEG4DescriptorParser=MPEG4DescriptorParser);var BoxParser={ERR_INVALID_DATA:-1,ERR_NOT_ENOUGH_DATA:0,OK:1,BASIC_BOXES:["mdat","idat","free","skip","meco","strk"],FULL_BOXES:["hmhd","nmhd","iods","xml ","bxml","ipro","mere"],CONTAINER_BOXES:[["moov",["trak","pssh"]],["trak"],["edts"],["mdia"],["minf"],["dinf"],["stbl",["sgpd","sbgp"]],["mvex",["trex"]],["moof",["traf"]],["traf",["trun","sgpd","sbgp"]],["vttc"],["tref"],["iref"],["mfra",["tfra"]],["meco"],["hnti"],["hinf"],["strk"],["strd"],["sinf"],["rinf"],["schi"],["trgr"],["udta",["kind"]],["iprp",["ipma"]],["ipco"]],boxCodes:[],fullBoxCodes:[],containerBoxCodes:[],sampleEntryCodes:{},sampleGroupEntryCodes:[],trackGroupTypes:[],UUIDBoxes:{},UUIDs:[],initialize:function(){BoxParser.FullBox.prototype=new BoxParser.Box,BoxParser.ContainerBox.prototype=new BoxParser.Box,BoxParser.SampleEntry.prototype=new BoxParser.Box,BoxParser.TrackGroupTypeBox.prototype=new BoxParser.FullBox,BoxParser.BASIC_BOXES.forEach(function(t){BoxParser.createBoxCtor(t)}),BoxParser.FULL_BOXES.forEach(function(t){BoxParser.createFullBoxCtor(t)}),BoxParser.CONTAINER_BOXES.forEach(function(t){BoxParser.createContainerBoxCtor(t[0],null,t[1])})},Box:function(t,e,i){this.type=t,this.size=e,this.uuid=i},FullBox:function(t,e,i){BoxParser.Box.call(this,t,e,i),this.flags=0,this.version=0},ContainerBox:function(t,e,i){BoxParser.Box.call(this,t,e,i),this.boxes=[]},SampleEntry:function(t,e,i,r){BoxParser.ContainerBox.call(this,t,e),this.hdr_size=i,this.start=r},SampleGroupEntry:function(t){this.grouping_type=t},TrackGroupTypeBox:function(t,e){BoxParser.FullBox.call(this,t,e)},createBoxCtor:function(e,t){BoxParser.boxCodes.push(e),BoxParser[e+"Box"]=function(t){BoxParser.Box.call(this,e,t)},BoxParser[e+"Box"].prototype=new BoxParser.Box,t&&(BoxParser[e+"Box"].prototype.parse=t)},createFullBoxCtor:function(e,i){BoxParser[e+"Box"]=function(t){BoxParser.FullBox.call(this,e,t)},BoxParser[e+"Box"].prototype=new BoxParser.FullBox,BoxParser[e+"Box"].prototype.parse=function(t){this.parseFullHeader(t),i&&i.call(this,t)}},addSubBoxArrays:function(t){if(t)for(var e=(this.subBoxNames=t).length,i=0;i<e;i++)this[t[i]+"s"]=[]},createContainerBoxCtor:function(e,t,i){BoxParser[e+"Box"]=function(t){BoxParser.ContainerBox.call(this,e,t),BoxParser.addSubBoxArrays.call(this,i)},BoxParser[e+"Box"].prototype=new BoxParser.ContainerBox,t&&(BoxParser[e+"Box"].prototype.parse=t)},createMediaSampleEntryCtor:function(t,e,i){BoxParser.sampleEntryCodes[t]=[],BoxParser[t+"SampleEntry"]=function(t,e){BoxParser.SampleEntry.call(this,t,e),BoxParser.addSubBoxArrays.call(this,i)},BoxParser[t+"SampleEntry"].prototype=new BoxParser.SampleEntry,e&&(BoxParser[t+"SampleEntry"].prototype.parse=e)},createSampleEntryCtor:function(e,i,t,r){BoxParser.sampleEntryCodes[e].push(i),BoxParser[i+"SampleEntry"]=function(t){BoxParser[e+"SampleEntry"].call(this,i,t),BoxParser.addSubBoxArrays.call(this,r)},BoxParser[i+"SampleEntry"].prototype=new BoxParser[e+"SampleEntry"],t&&(BoxParser[i+"SampleEntry"].prototype.parse=t)},createEncryptedSampleEntryCtor:function(t,e,i){BoxParser.createSampleEntryCtor.call(this,t,e,i,["sinf"])},createSampleGroupCtor:function(e,t){BoxParser[e+"SampleGroupEntry"]=function(t){BoxParser.SampleGroupEntry.call(this,e,t)},BoxParser[e+"SampleGroupEntry"].prototype=new BoxParser.SampleGroupEntry,t&&(BoxParser[e+"SampleGroupEntry"].prototype.parse=t)},createTrackGroupCtor:function(e,t){BoxParser[e+"TrackGroupTypeBox"]=function(t){BoxParser.TrackGroupTypeBox.call(this,e,t)},BoxParser[e+"TrackGroupTypeBox"].prototype=new BoxParser.TrackGroupTypeBox,t&&(BoxParser[e+"TrackGroupTypeBox"].prototype.parse=t)},createUUIDBox:function(e,i,r,s){BoxParser.UUIDs.push(e),BoxParser.UUIDBoxes[e]=function(t){(i?BoxParser.FullBox:r?BoxParser.ContainerBox:BoxParser.Box).call(this,"uuid",t,e)},BoxParser.UUIDBoxes[e].prototype=new(i?BoxParser.FullBox:r?BoxParser.ContainerBox:BoxParser.Box),s&&(BoxParser.UUIDBoxes[e].prototype.parse=i?function(t){this.parseFullHeader(t),s&&s.call(this,t)}:s)}};BoxParser.initialize(),BoxParser.TKHD_FLAG_ENABLED=1,BoxParser.TKHD_FLAG_IN_MOVIE=2,BoxParser.TKHD_FLAG_IN_PREVIEW=4,BoxParser.TFHD_FLAG_BASE_DATA_OFFSET=1,BoxParser.TFHD_FLAG_SAMPLE_DESC=2,BoxParser.TFHD_FLAG_SAMPLE_DUR=8,BoxParser.TFHD_FLAG_SAMPLE_SIZE=16,BoxParser.TFHD_FLAG_SAMPLE_FLAGS=32,BoxParser.TFHD_FLAG_DUR_EMPTY=65536,BoxParser.TFHD_FLAG_DEFAULT_BASE_IS_MOOF=131072,BoxParser.TRUN_FLAGS_DATA_OFFSET=1,BoxParser.TRUN_FLAGS_FIRST_FLAG=4,BoxParser.TRUN_FLAGS_DURATION=256,BoxParser.TRUN_FLAGS_SIZE=512,BoxParser.TRUN_FLAGS_FLAGS=1024,BoxParser.TRUN_FLAGS_CTS_OFFSET=2048,BoxParser.Box.prototype.add=function(t){return this.addBox(new BoxParser[t+"Box"])},BoxParser.Box.prototype.addBox=function(t){return this.boxes.push(t),this[t.type+"s"]?this[t.type+"s"].push(t):this[t.type]=t,t},BoxParser.Box.prototype.set=function(t,e){return this[t]=e,this},BoxParser.Box.prototype.addEntry=function(t,e){e=e||"entries";return this[e]||(this[e]=[]),this[e].push(t),this},"undefined"!=typeof exports&&(exports.BoxParser=BoxParser),BoxParser.parseUUID=function(t){return BoxParser.parseHex16(t)},BoxParser.parseHex16=function(t){for(var e="",i=0;i<16;i++){var r=t.readUint8().toString(16);e+=1===r.length?"0"+r:r}return e},BoxParser.parseOneBox=function(t,e,i){var r,s,a=t.getPosition(),n=0;if(t.getEndPosition()-a<8)return Log.debug("BoxParser","Not enough data in stream to parse the type and size of the box"),{code:BoxParser.ERR_NOT_ENOUGH_DATA};if(i&&i<8)return Log.debug("BoxParser","Not enough bytes left in the parent box to parse a new box"),{code:BoxParser.ERR_NOT_ENOUGH_DATA};var o=t.readUint32(),h=t.readString(4),d=h;if(Log.debug("BoxParser","Found box of type '"+h+"' and size "+o+" at position "+a),n=8,"uuid"==h){if(t.getEndPosition()-t.getPosition()<16||i-n<16)return t.seek(a),Log.debug("BoxParser","Not enough bytes left in the parent box to parse a UUID box"),{code:BoxParser.ERR_NOT_ENOUGH_DATA};n+=16,d=s=BoxParser.parseUUID(t)}if(1==o){if(t.getEndPosition()-t.getPosition()<8||i&&i-n<8)return t.seek(a),Log.warn("BoxParser",'Not enough data in stream to parse the extended size of the "'+h+'" box'),{code:BoxParser.ERR_NOT_ENOUGH_DATA};o=t.readUint64(),n+=8}else if(0===o)if(i)o=i;else if("mdat"!==h)return Log.error("BoxParser","Unlimited box size not supported for type: '"+h+"'"),r=new BoxParser.Box(h,o),{code:BoxParser.OK,box:r,size:r.size};return 0!==o&&o<n?(Log.error("BoxParser","Box of type "+h+" has an invalid size "+o+" (too small to be a box)"),{code:BoxParser.ERR_NOT_ENOUGH_DATA,type:h,size:o,hdr_size:n,start:a}):0!==o&&i&&i<o?(Log.error("BoxParser","Box of type '"+h+"' has a size "+o+" greater than its container size "+i),{code:BoxParser.ERR_NOT_ENOUGH_DATA,type:h,size:o,hdr_size:n,start:a}):0!==o&&a+o>t.getEndPosition()?(t.seek(a),Log.info("BoxParser","Not enough data in stream to parse the entire '"+h+"' box"),{code:BoxParser.ERR_NOT_ENOUGH_DATA,type:h,size:o,hdr_size:n,start:a}):e?{code:BoxParser.OK,type:h,size:o,hdr_size:n,start:a}:(BoxParser[h+"Box"]?r=new BoxParser[h+"Box"](o):"uuid"!==h?(Log.warn("BoxParser","Unknown box type: '"+h+"'"),(r=new BoxParser.Box(h,o)).has_unparsed_data=!0):BoxParser.UUIDBoxes[s]?r=new BoxParser.UUIDBoxes[s](o):(Log.warn("BoxParser","Unknown uuid type: '"+s+"'"),(r=new BoxParser.Box(h,o)).uuid=s,r.has_unparsed_data=!0),r.hdr_size=n,r.start=a,r.write===BoxParser.Box.prototype.write&&"mdat"!==r.type&&(Log.info("BoxParser","'"+d+"' box writing not yet implemented, keeping unparsed data in memory for later write"),r.parseDataAndRewind(t)),r.parse(t),(a=t.getPosition()-(r.start+r.size))<0?(Log.warn("BoxParser","Parsing of box '"+d+"' did not read the entire indicated box data size (missing "+-a+" bytes), seeking forward"),t.seek(r.start+r.size)):0<a&&(Log.error("BoxParser","Parsing of box '"+d+"' read "+a+" more bytes than the indicated box data size, seeking backwards"),0!==r.size&&t.seek(r.start+r.size)),{code:BoxParser.OK,box:r,size:r.size})},BoxParser.Box.prototype.parse=function(t){"mdat"!=this.type?this.data=t.readUint8Array(this.size-this.hdr_size):0===this.size?t.seek(t.getEndPosition()):t.seek(this.start+this.size)},BoxParser.Box.prototype.parseDataAndRewind=function(t){this.data=t.readUint8Array(this.size-this.hdr_size),t.position-=this.size-this.hdr_size},BoxParser.FullBox.prototype.parseDataAndRewind=function(t){this.parseFullHeader(t),this.data=t.readUint8Array(this.size-this.hdr_size),this.hdr_size-=4,t.position-=this.size-this.hdr_size},BoxParser.FullBox.prototype.parseFullHeader=function(t){this.version=t.readUint8(),this.flags=t.readUint24(),this.hdr_size+=4},BoxParser.FullBox.prototype.parse=function(t){this.parseFullHeader(t),this.data=t.readUint8Array(this.size-this.hdr_size)},BoxParser.ContainerBox.prototype.parse=function(t){for(;t.getPosition()<this.start+this.size;){if((e=BoxParser.parseOneBox(t,!1,this.size-(t.getPosition()-this.start))).code!==BoxParser.OK)return;var e,i=e.box;this.boxes.push(i),this.subBoxNames&&-1!=this.subBoxNames.indexOf(i.type)?this[this.subBoxNames[this.subBoxNames.indexOf(i.type)]+"s"].push(i):this[e="uuid"!==i.type?i.type:i.uuid]?Log.warn("Box of type "+e+" already stored in field of this type"):this[e]=i}},BoxParser.Box.prototype.parseLanguage=function(t){this.language=t.readUint16();t=[];t[0]=this.language>>10&31,t[1]=this.language>>5&31,t[2]=31&this.language,this.languageString=String.fromCharCode(t[0]+96,t[1]+96,t[2]+96)},BoxParser.SAMPLE_ENTRY_TYPE_VISUAL="Visual",BoxParser.SAMPLE_ENTRY_TYPE_AUDIO="Audio",BoxParser.SAMPLE_ENTRY_TYPE_HINT="Hint",BoxParser.SAMPLE_ENTRY_TYPE_METADATA="Metadata",BoxParser.SAMPLE_ENTRY_TYPE_SUBTITLE="Subtitle",BoxParser.SAMPLE_ENTRY_TYPE_SYSTEM="System",BoxParser.SAMPLE_ENTRY_TYPE_TEXT="Text",BoxParser.SampleEntry.prototype.parseHeader=function(t){t.readUint8Array(6),this.data_reference_index=t.readUint16(),this.hdr_size+=8},BoxParser.SampleEntry.prototype.parse=function(t){this.parseHeader(t),this.data=t.readUint8Array(this.size-this.hdr_size)},BoxParser.SampleEntry.prototype.parseDataAndRewind=function(t){this.parseHeader(t),this.data=t.readUint8Array(this.size-this.hdr_size),this.hdr_size-=8,t.position-=this.size-this.hdr_size},BoxParser.SampleEntry.prototype.parseFooter=function(t){BoxParser.ContainerBox.prototype.parse.call(this,t)},BoxParser.createMediaSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_HINT),BoxParser.createMediaSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_METADATA),BoxParser.createMediaSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_SUBTITLE),BoxParser.createMediaSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_SYSTEM),BoxParser.createMediaSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_TEXT),BoxParser.createMediaSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_VISUAL,function(t){var e;this.parseHeader(t),t.readUint16(),t.readUint16(),t.readUint32Array(3),this.width=t.readUint16(),this.height=t.readUint16(),this.horizresolution=t.readUint32(),this.vertresolution=t.readUint32(),t.readUint32(),this.frame_count=t.readUint16(),e=Math.min(31,t.readUint8()),this.compressorname=t.readString(e),e<31&&t.readString(31-e),this.depth=t.readUint16(),t.readUint16(),this.parseFooter(t)}),BoxParser.createMediaSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_AUDIO,function(t){this.parseHeader(t),t.readUint32Array(2),this.channel_count=t.readUint16(),this.samplesize=t.readUint16(),t.readUint16(),t.readUint16(),this.samplerate=t.readUint32()/65536,this.parseFooter(t)}),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_VISUAL,"avc1"),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_VISUAL,"avc2"),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_VISUAL,"avc3"),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_VISUAL,"avc4"),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_VISUAL,"av01"),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_VISUAL,"dav1"),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_VISUAL,"hvc1"),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_VISUAL,"hev1"),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_VISUAL,"hvt1"),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_VISUAL,"lhe1"),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_VISUAL,"dvh1"),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_VISUAL,"dvhe"),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_VISUAL,"vvc1"),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_VISUAL,"vvi1"),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_VISUAL,"vvs1"),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_VISUAL,"vvcN"),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_VISUAL,"vp08"),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_VISUAL,"vp09"),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_VISUAL,"avs3"),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_VISUAL,"j2ki"),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_VISUAL,"mjp2"),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_VISUAL,"mjpg"),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_AUDIO,"mp4a"),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_AUDIO,"ac-3"),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_AUDIO,"ac-4"),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_AUDIO,"ec-3"),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_AUDIO,"Opus"),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_AUDIO,"mha1"),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_AUDIO,"mha2"),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_AUDIO,"mhm1"),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_AUDIO,"mhm2"),BoxParser.createEncryptedSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_VISUAL,"encv"),BoxParser.createEncryptedSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_AUDIO,"enca"),BoxParser.createEncryptedSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_SUBTITLE,"encu"),BoxParser.createEncryptedSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_SYSTEM,"encs"),BoxParser.createEncryptedSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_TEXT,"enct"),BoxParser.createEncryptedSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_METADATA,"encm"),BoxParser.createBoxCtor("a1lx",function(t){var e=16*(1+(1&(1&t.readUint8())));this.layer_size=[];for(var i=0;i<3;i++)this.layer_size[i]=16==e?t.readUint16():t.readUint32()}),BoxParser.createBoxCtor("a1op",function(t){this.op_index=t.readUint8()}),BoxParser.createFullBoxCtor("auxC",function(t){this.aux_type=t.readCString();var e=this.size-this.hdr_size-(this.aux_type.length+1);this.aux_subtype=t.readUint8Array(e)}),BoxParser.createBoxCtor("av1C",function(t){var e=t.readUint8();if(e>>7&!1)Log.error("av1C marker problem");else if(this.version=127&e,1===this.version)if(e=t.readUint8(),this.seq_profile=e>>5&7,this.seq_level_idx_0=31&e,e=t.readUint8(),this.seq_tier_0=e>>7&1,this.high_bitdepth=e>>6&1,this.twelve_bit=e>>5&1,this.monochrome=e>>4&1,this.chroma_subsampling_x=e>>3&1,this.chroma_subsampling_y=e>>2&1,this.chroma_sample_position=3&e,e=t.readUint8(),this.reserved_1=e>>5&7,0===this.reserved_1){if(this.initial_presentation_delay_present=e>>4&1,1===this.initial_presentation_delay_present)this.initial_presentation_delay_minus_one=15&e;else if(this.reserved_2=15&e,0!==this.reserved_2)return void Log.error("av1C reserved_2 parsing problem");e=this.size-this.hdr_size-4;this.configOBUs=t.readUint8Array(e)}else Log.error("av1C reserved_1 parsing problem");else Log.error("av1C version "+this.version+" not supported")}),BoxParser.createBoxCtor("avcC",function(t){var e,i;for(this.configurationVersion=t.readUint8(),this.AVCProfileIndication=t.readUint8(),this.profile_compatibility=t.readUint8(),this.AVCLevelIndication=t.readUint8(),this.lengthSizeMinusOne=3&t.readUint8(),this.nb_SPS_nalus=31&t.readUint8(),i=this.size-this.hdr_size-6,this.SPS=[],e=0;e<this.nb_SPS_nalus;e++)this.SPS[e]={},this.SPS[e].length=t.readUint16(),this.SPS[e].nalu=t.readUint8Array(this.SPS[e].length),i-=2+this.SPS[e].length;for(this.nb_PPS_nalus=t.readUint8(),i--,this.PPS=[],e=0;e<this.nb_PPS_nalus;e++)this.PPS[e]={},this.PPS[e].length=t.readUint16(),this.PPS[e].nalu=t.readUint8Array(this.PPS[e].length),i-=2+this.PPS[e].length;0<i&&(this.ext=t.readUint8Array(i))}),BoxParser.createBoxCtor("btrt",function(t){this.bufferSizeDB=t.readUint32(),this.maxBitrate=t.readUint32(),this.avgBitrate=t.readUint32()}),BoxParser.createBoxCtor("clap",function(t){this.cleanApertureWidthN=t.readUint32(),this.cleanApertureWidthD=t.readUint32(),this.cleanApertureHeightN=t.readUint32(),this.cleanApertureHeightD=t.readUint32(),this.horizOffN=t.readUint32(),this.horizOffD=t.readUint32(),this.vertOffN=t.readUint32(),this.vertOffD=t.readUint32()}),BoxParser.createBoxCtor("clli",function(t){this.max_content_light_level=t.readUint16(),this.max_pic_average_light_level=t.readUint16()}),BoxParser.createFullBoxCtor("co64",function(t){var e,i=t.readUint32();if(this.chunk_offsets=[],0===this.version)for(e=0;e<i;e++)this.chunk_offsets.push(t.readUint64())}),BoxParser.createFullBoxCtor("CoLL",function(t){this.maxCLL=t.readUint16(),this.maxFALL=t.readUint16()}),BoxParser.createBoxCtor("colr",function(t){var e;this.colour_type=t.readString(4),"nclx"===this.colour_type?(this.colour_primaries=t.readUint16(),this.transfer_characteristics=t.readUint16(),this.matrix_coefficients=t.readUint16(),e=t.readUint8(),this.full_range_flag=e>>7):"rICC"!==this.colour_type&&"prof"!==this.colour_type||(this.ICC_profile=t.readUint8Array(this.size-4))}),BoxParser.createFullBoxCtor("cprt",function(t){this.parseLanguage(t),this.notice=t.readCString()}),BoxParser.createFullBoxCtor("cslg",function(t){0===this.version&&(this.compositionToDTSShift=t.readInt32(),this.leastDecodeToDisplayDelta=t.readInt32(),this.greatestDecodeToDisplayDelta=t.readInt32(),this.compositionStartTime=t.readInt32(),this.compositionEndTime=t.readInt32())}),BoxParser.createFullBoxCtor("ctts",function(t){var e,i=t.readUint32();if(this.sample_counts=[],this.sample_offsets=[],0===this.version)for(e=0;e<i;e++){this.sample_counts.push(t.readUint32());var r=t.readInt32();r<0&&Log.warn("BoxParser","ctts box uses negative values without using version 1"),this.sample_offsets.push(r)}else if(1==this.version)for(e=0;e<i;e++)this.sample_counts.push(t.readUint32()),this.sample_offsets.push(t.readInt32())}),BoxParser.createBoxCtor("dac3",function(t){var e=t.readUint8(),i=t.readUint8(),t=t.readUint8();this.fscod=e>>6,this.bsid=e>>1&31,this.bsmod=(1&e)<<2|i>>6&3,this.acmod=i>>3&7,this.lfeon=i>>2&1,this.bit_rate_code=3&i|t>>5&7}),BoxParser.createBoxCtor("dec3",function(t){var e=t.readUint16();this.data_rate=e>>3,this.num_ind_sub=7&e,this.ind_subs=[];for(var i=0;i<this.num_ind_sub+1;i++){var r={};this.ind_subs.push(r);var s=t.readUint8(),a=t.readUint8(),n=t.readUint8();r.fscod=s>>6,r.bsid=s>>1&31,r.bsmod=(1&s)<<4|a>>4&15,r.acmod=a>>1&7,r.lfeon=1&a,r.num_dep_sub=n>>1&15,0<r.num_dep_sub&&(r.chan_loc=(1&n)<<8|t.readUint8())}}),BoxParser.createFullBoxCtor("dfLa",function(t){var e=[],i=["STREAMINFO","PADDING","APPLICATION","SEEKTABLE","VORBIS_COMMENT","CUESHEET","PICTURE","RESERVED"];for(this.parseFullHeader(t);;){var r=t.readUint8(),s=Math.min(127&r,i.length-1);if(s?t.readUint8Array(t.readUint24()):(t.readUint8Array(13),this.samplerate=t.readUint32()>>12,t.readUint8Array(20)),e.push(i[s]),128&r)break}this.numMetadataBlocks=e.length+" ("+e.join(", ")+")"}),BoxParser.createBoxCtor("dimm",function(t){this.bytessent=t.readUint64()}),BoxParser.createBoxCtor("dmax",function(t){this.time=t.readUint32()}),BoxParser.createBoxCtor("dmed",function(t){this.bytessent=t.readUint64()}),BoxParser.createBoxCtor("dOps",function(t){if(this.Version=t.readUint8(),this.OutputChannelCount=t.readUint8(),this.PreSkip=t.readUint16(),this.InputSampleRate=t.readUint32(),this.OutputGain=t.readInt16(),this.ChannelMappingFamily=t.readUint8(),0!==this.ChannelMappingFamily){this.StreamCount=t.readUint8(),this.CoupledCount=t.readUint8(),this.ChannelMapping=[];for(var e=0;e<this.OutputChannelCount;e++)this.ChannelMapping[e]=t.readUint8()}}),BoxParser.createFullBoxCtor("dref",function(t){var e;this.entries=[];for(var i=t.readUint32(),r=0;r<i;r++){if((e=BoxParser.parseOneBox(t,!1,this.size-(t.getPosition()-this.start))).code!==BoxParser.OK)return;e=e.box,this.entries.push(e)}}),BoxParser.createBoxCtor("drep",function(t){this.bytessent=t.readUint64()}),BoxParser.createFullBoxCtor("elng",function(t){this.extended_language=t.readString(this.size-this.hdr_size)}),BoxParser.createFullBoxCtor("elst",function(t){this.entries=[];for(var e=t.readUint32(),i=0;i<e;i++){var r={};this.entries.push(r),1===this.version?(r.segment_duration=t.readUint64(),r.media_time=t.readInt64()):(r.segment_duration=t.readUint32(),r.media_time=t.readInt32()),r.media_rate_integer=t.readInt16(),r.media_rate_fraction=t.readInt16()}}),BoxParser.createFullBoxCtor("emsg",function(t){1==this.version?(this.timescale=t.readUint32(),this.presentation_time=t.readUint64(),this.event_duration=t.readUint32(),this.id=t.readUint32(),this.scheme_id_uri=t.readCString(),this.value=t.readCString()):(this.scheme_id_uri=t.readCString(),this.value=t.readCString(),this.timescale=t.readUint32(),this.presentation_time_delta=t.readUint32(),this.event_duration=t.readUint32(),this.id=t.readUint32());var e=this.size-this.hdr_size-(16+(this.scheme_id_uri.length+1)+(this.value.length+1));1==this.version&&(e-=4),this.message_data=t.readUint8Array(e)}),BoxParser.createFullBoxCtor("esds",function(t){var e=t.readUint8Array(this.size-this.hdr_size);void 0!==MPEG4DescriptorParser&&(t=new MPEG4DescriptorParser,this.esd=t.parseOneDescriptor(new DataStream(e.buffer,0,DataStream.BIG_ENDIAN)))}),BoxParser.createBoxCtor("fiel",function(t){this.fieldCount=t.readUint8(),this.fieldOrdering=t.readUint8()}),BoxParser.createBoxCtor("frma",function(t){this.data_format=t.readString(4)}),BoxParser.createBoxCtor("ftyp",function(t){var e=this.size-this.hdr_size;this.major_brand=t.readString(4),this.minor_version=t.readUint32(),e-=8,this.compatible_brands=[];for(var i=0;4<=e;)this.compatible_brands[i]=t.readString(4),e-=4,i++}),BoxParser.createFullBoxCtor("hdlr",function(t){0===this.version&&(t.readUint32(),this.handler=t.readString(4),t.readUint32Array(3),this.name=t.readString(this.size-this.hdr_size-20),"\0"===this.name[this.name.length-1]&&(this.name=this.name.slice(0,-1)))}),BoxParser.createBoxCtor("hvcC",function(t){var e,i;this.configurationVersion=t.readUint8(),i=t.readUint8(),this.general_profile_space=i>>6,this.general_tier_flag=(32&i)>>5,this.general_profile_idc=31&i,this.general_profile_compatibility=t.readUint32(),this.general_constraint_indicator=t.readUint8Array(6),this.general_level_idc=t.readUint8(),this.min_spatial_segmentation_idc=4095&t.readUint16(),this.parallelismType=3&t.readUint8(),this.chroma_format_idc=3&t.readUint8(),this.bit_depth_luma_minus8=7&t.readUint8(),this.bit_depth_chroma_minus8=7&t.readUint8(),this.avgFrameRate=t.readUint16(),i=t.readUint8(),this.constantFrameRate=i>>6,this.numTemporalLayers=(13&i)>>3,this.temporalIdNested=(4&i)>>2,this.lengthSizeMinusOne=3&i,this.nalu_arrays=[];for(var r=t.readUint8(),s=0;s<r;s++){var a=[];this.nalu_arrays.push(a),i=t.readUint8(),a.completeness=(128&i)>>7,a.nalu_type=63&i;for(var n=t.readUint16(),o=0;o<n;o++){var h={};a.push(h),e=t.readUint16(),h.data=t.readUint8Array(e)}}}),BoxParser.createFullBoxCtor("iinf",function(t){var e;0===this.version?this.entry_count=t.readUint16():this.entry_count=t.readUint32(),this.item_infos=[];for(var i=0;i<this.entry_count;i++){if((e=BoxParser.parseOneBox(t,!1,this.size-(t.getPosition()-this.start))).code!==BoxParser.OK)return;"infe"!==e.box.type&&Log.error("BoxParser","Expected 'infe' box, got "+e.box.type),this.item_infos[i]=e.box}}),BoxParser.createFullBoxCtor("iloc",function(t){var e=t.readUint8();this.offset_size=e>>4&15,this.length_size=15&e,e=t.readUint8(),this.base_offset_size=e>>4&15,1===this.version||2===this.version?this.index_size=15&e:this.index_size=0,this.items=[];var i=0;if(this.version<2)i=t.readUint16();else{if(2!==this.version)throw"version of iloc box not supported";i=t.readUint32()}for(var r=0;r<i;r++){var s={};if(this.items.push(s),this.version<2)s.item_ID=t.readUint16();else{if(2!==this.version)throw"version of iloc box not supported";s.item_ID=t.readUint16()}switch(1===this.version||2===this.version?s.construction_method=15&t.readUint16():s.construction_method=0,s.data_reference_index=t.readUint16(),this.base_offset_size){case 0:s.base_offset=0;break;case 4:s.base_offset=t.readUint32();break;case 8:s.base_offset=t.readUint64();break;default:throw"Error reading base offset size"}var a=t.readUint16();s.extents=[];for(var n=0;n<a;n++){var o={};if(s.extents.push(o),1===this.version||2===this.version)switch(this.index_size){case 0:o.extent_index=0;break;case 4:o.extent_index=t.readUint32();break;case 8:o.extent_index=t.readUint64();break;default:throw"Error reading extent index"}switch(this.offset_size){case 0:o.extent_offset=0;break;case 4:o.extent_offset=t.readUint32();break;case 8:o.extent_offset=t.readUint64();break;default:throw"Error reading extent index"}switch(this.length_size){case 0:o.extent_length=0;break;case 4:o.extent_length=t.readUint32();break;case 8:o.extent_length=t.readUint64();break;default:throw"Error reading extent index"}}}}),BoxParser.createBoxCtor("imir",function(t){t=t.readUint8();this.reserved=t>>7,this.axis=1&t}),BoxParser.createFullBoxCtor("infe",function(t){return 0!==this.version&&1!==this.version||(this.item_ID=t.readUint16(),this.item_protection_index=t.readUint16(),this.item_name=t.readCString(),this.content_type=t.readCString(),this.content_encoding=t.readCString()),1===this.version?(this.extension_type=t.readString(4),Log.warn("BoxParser","Cannot parse extension type"),void t.seek(this.start+this.size)):void(2<=this.version&&(2===this.version?this.item_ID=t.readUint16():3===this.version&&(this.item_ID=t.readUint32()),this.item_protection_index=t.readUint16(),this.item_type=t.readString(4),this.item_name=t.readCString(),"mime"===this.item_type?(this.content_type=t.readCString(),this.content_encoding=t.readCString()):"uri "===this.item_type&&(this.item_uri_type=t.readCString())))}),BoxParser.createFullBoxCtor("ipma",function(t){var e,i;for(entry_count=t.readUint32(),this.associations=[],e=0;e<entry_count;e++){var r={};this.associations.push(r),this.version<1?r.id=t.readUint16():r.id=t.readUint32();var s=t.readUint8();for(r.props=[],i=0;i<s;i++){var a=t.readUint8(),n={};r.props.push(n),n.essential=(128&a)>>7==1,1&this.flags?n.property_index=(127&a)<<8|t.readUint8():n.property_index=127&a}}}),BoxParser.createFullBoxCtor("iref",function(t){var e;for(this.references=[];t.getPosition()<this.start+this.size;){if((e=BoxParser.parseOneBox(t,!0,this.size-(t.getPosition()-this.start))).code!==BoxParser.OK)return;(e=new(0===this.version?BoxParser.SingleItemTypeReferenceBox:BoxParser.SingleItemTypeReferenceBoxLarge)(e.type,e.size,e.hdr_size,e.start)).write===BoxParser.Box.prototype.write&&"mdat"!==e.type&&(Log.warn("BoxParser",e.type+" box writing not yet implemented, keeping unparsed data in memory for later write"),e.parseDataAndRewind(t)),e.parse(t),this.references.push(e)}}),BoxParser.createBoxCtor("irot",function(t){this.angle=3&t.readUint8()}),BoxParser.createFullBoxCtor("ispe",function(t){this.image_width=t.readUint32(),this.image_height=t.readUint32()}),BoxParser.createFullBoxCtor("kind",function(t){this.schemeURI=t.readCString(),this.value=t.readCString()}),BoxParser.createFullBoxCtor("leva",function(t){var e=t.readUint8();this.levels=[];for(var i=0;i<e;i++){var r={};(this.levels[i]=r).track_ID=t.readUint32();var s=t.readUint8();switch(r.padding_flag=s>>7,r.assignment_type=127&s,r.assignment_type){case 0:r.grouping_type=t.readString(4);break;case 1:r.grouping_type=t.readString(4),r.grouping_type_parameter=t.readUint32();break;case 2:case 3:break;case 4:r.sub_track_id=t.readUint32();break;default:Log.warn("BoxParser","Unknown leva assignement type")}}}),BoxParser.createBoxCtor("lsel",function(t){this.layer_id=t.readUint16()}),BoxParser.createBoxCtor("maxr",function(t){this.period=t.readUint32(),this.bytes=t.readUint32()}),BoxParser.createBoxCtor("mdcv",function(t){this.display_primaries=[],this.display_primaries[0]={},this.display_primaries[0].x=t.readUint16(),this.display_primaries[0].y=t.readUint16(),this.display_primaries[1]={},this.display_primaries[1].x=t.readUint16(),this.display_primaries[1].y=t.readUint16(),this.display_primaries[2]={},this.display_primaries[2].x=t.readUint16(),this.display_primaries[2].y=t.readUint16(),this.white_point={},this.white_point.x=t.readUint16(),this.white_point.y=t.readUint16(),this.max_display_mastering_luminance=t.readUint32(),this.min_display_mastering_luminance=t.readUint32()}),BoxParser.createFullBoxCtor("mdhd",function(t){1==this.version?(this.creation_time=t.readUint64(),this.modification_time=t.readUint64(),this.timescale=t.readUint32(),this.duration=t.readUint64()):(this.creation_time=t.readUint32(),this.modification_time=t.readUint32(),this.timescale=t.readUint32(),this.duration=t.readUint32()),this.parseLanguage(t),t.readUint16()}),BoxParser.createFullBoxCtor("mehd",function(t){1&this.flags&&(Log.warn("BoxParser","mehd box incorrectly uses flags set to 1, converting version to 1"),this.version=1),1==this.version?this.fragment_duration=t.readUint64():this.fragment_duration=t.readUint32()}),BoxParser.createFullBoxCtor("meta",function(t){this.boxes=[],BoxParser.ContainerBox.prototype.parse.call(this,t)}),BoxParser.createFullBoxCtor("mfhd",function(t){this.sequence_number=t.readUint32()}),BoxParser.createFullBoxCtor("mfro",function(t){this._size=t.readUint32()}),BoxParser.createFullBoxCtor("mvhd",function(t){1==this.version?(this.creation_time=t.readUint64(),this.modification_time=t.readUint64(),this.timescale=t.readUint32(),this.duration=t.readUint64()):(this.creation_time=t.readUint32(),this.modification_time=t.readUint32(),this.timescale=t.readUint32(),this.duration=t.readUint32()),this.rate=t.readUint32(),this.volume=t.readUint16()>>8,t.readUint16(),t.readUint32Array(2),this.matrix=t.readUint32Array(9),t.readUint32Array(6),this.next_track_id=t.readUint32()}),BoxParser.createBoxCtor("npck",function(t){this.packetssent=t.readUint32()}),BoxParser.createBoxCtor("nump",function(t){this.packetssent=t.readUint64()}),BoxParser.createFullBoxCtor("padb",function(t){var e=t.readUint32();this.padbits=[];for(var i=0;i<Math.floor((e+1)/2);i++)this.padbits=t.readUint8()}),BoxParser.createBoxCtor("pasp",function(t){this.hSpacing=t.readUint32(),this.vSpacing=t.readUint32()}),BoxParser.createBoxCtor("payl",function(t){this.text=t.readString(this.size-this.hdr_size)}),BoxParser.createBoxCtor("payt",function(t){this.payloadID=t.readUint32();var e=t.readUint8();this.rtpmap_string=t.readString(e)}),BoxParser.createFullBoxCtor("pdin",function(t){var e=(this.size-this.hdr_size)/8;this.rate=[],this.initial_delay=[];for(var i=0;i<e;i++)this.rate[i]=t.readUint32(),this.initial_delay[i]=t.readUint32()}),BoxParser.createFullBoxCtor("pitm",function(t){0===this.version?this.item_id=t.readUint16():this.item_id=t.readUint32()}),BoxParser.createFullBoxCtor("pixi",function(t){var e;for(this.num_channels=t.readUint8(),this.bits_per_channels=[],e=0;e<this.num_channels;e++)this.bits_per_channels[e]=t.readUint8()}),BoxParser.createBoxCtor("pmax",function(t){this.bytes=t.readUint32()}),BoxParser.createFullBoxCtor("prft",function(t){this.ref_track_id=t.readUint32(),this.ntp_timestamp=t.readUint64(),0===this.version?this.media_time=t.readUint32():this.media_time=t.readUint64()}),BoxParser.createFullBoxCtor("pssh",function(t){if(this.system_id=BoxParser.parseHex16(t),0<this.version){var e=t.readUint32();this.kid=[];for(var i=0;i<e;i++)this.kid[i]=BoxParser.parseHex16(t)}var r=t.readUint32();0<r&&(this.data=t.readUint8Array(r))}),BoxParser.createFullBoxCtor("clef",function(t){this.width=t.readUint32(),this.height=t.readUint32()}),BoxParser.createFullBoxCtor("enof",function(t){this.width=t.readUint32(),this.height=t.readUint32()}),BoxParser.createFullBoxCtor("prof",function(t){this.width=t.readUint32(),this.height=t.readUint32()}),BoxParser.createContainerBoxCtor("tapt",null,["clef","prof","enof"]),BoxParser.createBoxCtor("rtp ",function(t){this.descriptionformat=t.readString(4),this.sdptext=t.readString(this.size-this.hdr_size-4)}),BoxParser.createFullBoxCtor("saio",function(t){1&this.flags&&(this.aux_info_type=t.readUint32(),this.aux_info_type_parameter=t.readUint32());var e=t.readUint32();this.offset=[];for(var i=0;i<e;i++)0===this.version?this.offset[i]=t.readUint32():this.offset[i]=t.readUint64()}),BoxParser.createFullBoxCtor("saiz",function(t){1&this.flags&&(this.aux_info_type=t.readUint32(),this.aux_info_type_parameter=t.readUint32()),this.default_sample_info_size=t.readUint8();var e=t.readUint32();if(this.sample_info_size=[],0===this.default_sample_info_size)for(var i=0;i<e;i++)this.sample_info_size[i]=t.readUint8()}),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_METADATA,"mett",function(t){this.parseHeader(t),this.content_encoding=t.readCString(),this.mime_format=t.readCString(),this.parseFooter(t)}),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_METADATA,"metx",function(t){this.parseHeader(t),this.content_encoding=t.readCString(),this.namespace=t.readCString(),this.schema_location=t.readCString(),this.parseFooter(t)}),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_SUBTITLE,"sbtt",function(t){this.parseHeader(t),this.content_encoding=t.readCString(),this.mime_format=t.readCString(),this.parseFooter(t)}),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_SUBTITLE,"stpp",function(t){this.parseHeader(t),this.namespace=t.readCString(),this.schema_location=t.readCString(),this.auxiliary_mime_types=t.readCString(),this.parseFooter(t)}),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_SUBTITLE,"stxt",function(t){this.parseHeader(t),this.content_encoding=t.readCString(),this.mime_format=t.readCString(),this.parseFooter(t)}),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_SUBTITLE,"tx3g",function(t){this.parseHeader(t),this.displayFlags=t.readUint32(),this.horizontal_justification=t.readInt8(),this.vertical_justification=t.readInt8(),this.bg_color_rgba=t.readUint8Array(4),this.box_record=t.readInt16Array(4),this.style_record=t.readUint8Array(12),this.parseFooter(t)}),BoxParser.createSampleEntryCtor(BoxParser.SAMPLE_ENTRY_TYPE_METADATA,"wvtt",function(t){this.parseHeader(t),this.parseFooter(t)}),BoxParser.createSampleGroupCtor("alst",function(t){var e,i=t.readUint16();for(this.first_output_sample=t.readUint16(),this.sample_offset=[],e=0;e<i;e++)this.sample_offset[e]=t.readUint32();var r=this.description_length-4-4*i;for(this.num_output_samples=[],this.num_total_samples=[],e=0;e<r/4;e++)this.num_output_samples[e]=t.readUint16(),this.num_total_samples[e]=t.readUint16()}),BoxParser.createSampleGroupCtor("avll",function(t){this.layerNumber=t.readUint8(),this.accurateStatisticsFlag=t.readUint8(),this.avgBitRate=t.readUint16(),this.avgFrameRate=t.readUint16()}),BoxParser.createSampleGroupCtor("avss",function(t){this.subSequenceIdentifier=t.readUint16(),this.layerNumber=t.readUint8();var e=t.readUint8();this.durationFlag=e>>7,this.avgRateFlag=e>>6&1,this.durationFlag&&(this.duration=t.readUint32()),this.avgRateFlag&&(this.accurateStatisticsFlag=t.readUint8(),this.avgBitRate=t.readUint16(),this.avgFrameRate=t.readUint16()),this.dependency=[];for(var i=t.readUint8(),r=0;r<i;r++){var s={};this.dependency.push(s),s.subSeqDirectionFlag=t.readUint8(),s.layerNumber=t.readUint8(),s.subSequenceIdentifier=t.readUint16()}}),BoxParser.createSampleGroupCtor("dtrt",function(t){Log.warn("BoxParser","Sample Group type: "+this.grouping_type+" not fully parsed")}),BoxParser.createSampleGroupCtor("mvif",function(t){Log.warn("BoxParser","Sample Group type: "+this.grouping_type+" not fully parsed")}),BoxParser.createSampleGroupCtor("prol",function(t){this.roll_distance=t.readInt16()}),BoxParser.createSampleGroupCtor("rap ",function(t){t=t.readUint8();this.num_leading_samples_known=t>>7,this.num_leading_samples=127&t}),BoxParser.createSampleGroupCtor("rash",function(t){if(this.operation_point_count=t.readUint16(),this.description_length!==2+(1===this.operation_point_count?2:6*this.operation_point_count)+9)Log.warn("BoxParser","Mismatch in "+this.grouping_type+" sample group length"),this.data=t.readUint8Array(this.description_length-2);else{if(1===this.operation_point_count)this.target_rate_share=t.readUint16();else{this.target_rate_share=[],this.available_bitrate=[];for(var e=0;e<this.operation_point_count;e++)this.available_bitrate[e]=t.readUint32(),this.target_rate_share[e]=t.readUint16()}this.maximum_bitrate=t.readUint32(),this.minimum_bitrate=t.readUint32(),this.discard_priority=t.readUint8()}}),BoxParser.createSampleGroupCtor("roll",function(t){this.roll_distance=t.readInt16()}),BoxParser.SampleGroupEntry.prototype.parse=function(t){Log.warn("BoxParser","Unknown Sample Group type: "+this.grouping_type),this.data=t.readUint8Array(this.description_length)},BoxParser.createSampleGroupCtor("scif",function(t){Log.warn("BoxParser","Sample Group type: "+this.grouping_type+" not fully parsed")}),BoxParser.createSampleGroupCtor("scnm",function(t){Log.warn("BoxParser","Sample Group type: "+this.grouping_type+" not fully parsed")}),BoxParser.createSampleGroupCtor("seig",function(t){this.reserved=t.readUint8();var e=t.readUint8();this.crypt_byte_block=e>>4,this.skip_byte_block=15&e,this.isProtected=t.readUint8(),this.Per_Sample_IV_Size=t.readUint8(),this.KID=BoxParser.parseHex16(t),this.constant_IV_size=0,this.constant_IV=0,1===this.isProtected&&0===this.Per_Sample_IV_Size&&(this.constant_IV_size=t.readUint8(),this.constant_IV=t.readUint8Array(this.constant_IV_size))}),BoxParser.createSampleGroupCtor("stsa",function(t){Log.warn("BoxParser","Sample Group type: "+this.grouping_type+" not fully parsed")}),BoxParser.createSampleGroupCtor("sync",function(t){t=t.readUint8();this.NAL_unit_type=63&t}),BoxParser.createSampleGroupCtor("tele",function(t){t=t.readUint8();this.level_independently_decodable=t>>7}),BoxParser.createSampleGroupCtor("tsas",function(t){Log.warn("BoxParser","Sample Group type: "+this.grouping_type+" not fully parsed")}),BoxParser.createSampleGroupCtor("tscl",function(t){Log.warn("BoxParser","Sample Group type: "+this.grouping_type+" not fully parsed")}),BoxParser.createSampleGroupCtor("vipr",function(t){Log.warn("BoxParser","Sample Group type: "+this.grouping_type+" not fully parsed")}),BoxParser.createFullBoxCtor("sbgp",function(t){this.grouping_type=t.readString(4),1===this.version?this.grouping_type_parameter=t.readUint32():this.grouping_type_parameter=0,this.entries=[];for(var e=t.readUint32(),i=0;i<e;i++){var r={};this.entries.push(r),r.sample_count=t.readInt32(),r.group_description_index=t.readInt32()}}),BoxParser.createFullBoxCtor("schm",function(t){this.scheme_type=t.readString(4),this.scheme_version=t.readUint32(),1&this.flags&&(this.scheme_uri=t.readString(this.size-this.hdr_size-8))}),BoxParser.createBoxCtor("sdp ",function(t){this.sdptext=t.readString(this.size-this.hdr_size)}),BoxParser.createFullBoxCtor("sdtp",function(t){var e,i=this.size-this.hdr_size;this.is_leading=[],this.sample_depends_on=[],this.sample_is_depended_on=[],this.sample_has_redundancy=[];for(var r=0;r<i;r++)e=t.readUint8(),this.is_leading[r]=e>>6,this.sample_depends_on[r]=e>>4&3,this.sample_is_depended_on[r]=e>>2&3,this.sample_has_redundancy[r]=3&e}),BoxParser.createFullBoxCtor("senc"),BoxParser.createFullBoxCtor("sgpd",function(t){this.grouping_type=t.readString(4),Log.debug("BoxParser","Found Sample Groups of type "+this.grouping_type),1===this.version?this.default_length=t.readUint32():this.default_length=0,2<=this.version&&(this.default_group_description_index=t.readUint32()),this.entries=[];for(var e=t.readUint32(),i=0;i<e;i++){var r=new(BoxParser[this.grouping_type+"SampleGroupEntry"]?BoxParser[this.grouping_type+"SampleGroupEntry"]:BoxParser.SampleGroupEntry)(this.grouping_type);this.entries.push(r),1===this.version&&0===this.default_length?r.description_length=t.readUint32():r.description_length=this.default_length,r.write===BoxParser.SampleGroupEntry.prototype.write&&(Log.info("BoxParser","SampleGroup for type "+this.grouping_type+" writing not yet implemented, keeping unparsed data in memory for later write"),r.data=t.readUint8Array(r.description_length),t.position-=r.description_length),r.parse(t)}}),BoxParser.createFullBoxCtor("sidx",function(t){this.reference_ID=t.readUint32(),this.timescale=t.readUint32(),0===this.version?(this.earliest_presentation_time=t.readUint32(),this.first_offset=t.readUint32()):(this.earliest_presentation_time=t.readUint64(),this.first_offset=t.readUint64()),t.readUint16(),this.references=[];for(var e=t.readUint16(),i=0;i<e;i++){var r={};this.references.push(r);var s=t.readUint32();r.reference_type=s>>31&1,r.referenced_size=2147483647&s,r.subsegment_duration=t.readUint32(),s=t.readUint32(),r.starts_with_SAP=s>>31&1,r.SAP_type=s>>28&7,r.SAP_delta_time=268435455&s}}),BoxParser.SingleItemTypeReferenceBox=function(t,e,i,r){BoxParser.Box.call(this,t,e),this.hdr_size=i,this.start=r},BoxParser.SingleItemTypeReferenceBox.prototype=new BoxParser.Box,BoxParser.SingleItemTypeReferenceBox.prototype.parse=function(t){this.from_item_ID=t.readUint16();var e=t.readUint16();this.references=[];for(var i=0;i<e;i++)this.references[i]=t.readUint16()},BoxParser.SingleItemTypeReferenceBoxLarge=function(t,e,i,r){BoxParser.Box.call(this,t,e),this.hdr_size=i,this.start=r},BoxParser.SingleItemTypeReferenceBoxLarge.prototype=new BoxParser.Box,BoxParser.SingleItemTypeReferenceBoxLarge.prototype.parse=function(t){this.from_item_ID=t.readUint32();var e=t.readUint16();this.references=[];for(var i=0;i<e;i++)this.references[i]=t.readUint32()},BoxParser.createFullBoxCtor("SmDm",function(t){this.primaryRChromaticity_x=t.readUint16(),this.primaryRChromaticity_y=t.readUint16(),this.primaryGChromaticity_x=t.readUint16(),this.primaryGChromaticity_y=t.readUint16(),this.primaryBChromaticity_x=t.readUint16(),this.primaryBChromaticity_y=t.readUint16(),this.whitePointChromaticity_x=t.readUint16(),this.whitePointChromaticity_y=t.readUint16(),this.luminanceMax=t.readUint32(),this.luminanceMin=t.readUint32()}),BoxParser.createFullBoxCtor("smhd",function(t){this.balance=t.readUint16(),t.readUint16()}),BoxParser.createFullBoxCtor("ssix",function(t){this.subsegments=[];for(var e=t.readUint32(),i=0;i<e;i++){var r={};this.subsegments.push(r),r.ranges=[];for(var s=t.readUint32(),a=0;a<s;a++){var n={};r.ranges.push(n),n.level=t.readUint8(),n.range_size=t.readUint24()}}}),BoxParser.createFullBoxCtor("stco",function(t){var e=t.readUint32();if(this.chunk_offsets=[],0===this.version)for(var i=0;i<e;i++)this.chunk_offsets.push(t.readUint32())}),BoxParser.createFullBoxCtor("stdp",function(t){var e=(this.size-this.hdr_size)/2;this.priority=[];for(var i=0;i<e;i++)this.priority[i]=t.readUint16()}),BoxParser.createFullBoxCtor("sthd"),BoxParser.createFullBoxCtor("stri",function(t){this.switch_group=t.readUint16(),this.alternate_group=t.readUint16(),this.sub_track_id=t.readUint32();var e=(this.size-this.hdr_size-8)/4;this.attribute_list=[];for(var i=0;i<e;i++)this.attribute_list[i]=t.readUint32()}),BoxParser.createFullBoxCtor("stsc",function(t){var e,i=t.readUint32();if(this.first_chunk=[],this.samples_per_chunk=[],this.sample_description_index=[],0===this.version)for(e=0;e<i;e++)this.first_chunk.push(t.readUint32()),this.samples_per_chunk.push(t.readUint32()),this.sample_description_index.push(t.readUint32())}),BoxParser.createFullBoxCtor("stsd",function(t){var e,i,r,s;for(this.entries=[],r=t.readUint32(),e=1;e<=r;e++){if((i=BoxParser.parseOneBox(t,!0,this.size-(t.getPosition()-this.start))).code!==BoxParser.OK)return;BoxParser[i.type+"SampleEntry"]?((s=new BoxParser[i.type+"SampleEntry"](i.size)).hdr_size=i.hdr_size,s.start=i.start):(Log.warn("BoxParser","Unknown sample entry type: "+i.type),s=new BoxParser.SampleEntry(i.type,i.size,i.hdr_size,i.start)),s.write===BoxParser.SampleEntry.prototype.write&&(Log.info("BoxParser","SampleEntry "+s.type+" box writing not yet implemented, keeping unparsed data in memory for later write"),s.parseDataAndRewind(t)),s.parse(t),this.entries.push(s)}}),BoxParser.createFullBoxCtor("stsg",function(t){this.grouping_type=t.readUint32();var e=t.readUint16();this.group_description_index=[];for(var i=0;i<e;i++)this.group_description_index[i]=t.readUint32()}),BoxParser.createFullBoxCtor("stsh",function(t){var e,i=t.readUint32();if(this.shadowed_sample_numbers=[],this.sync_sample_numbers=[],0===this.version)for(e=0;e<i;e++)this.shadowed_sample_numbers.push(t.readUint32()),this.sync_sample_numbers.push(t.readUint32())}),BoxParser.createFullBoxCtor("stss",function(t){var e,i=t.readUint32();if(0===this.version)for(this.sample_numbers=[],e=0;e<i;e++)this.sample_numbers.push(t.readUint32())}),BoxParser.createFullBoxCtor("stsz",function(t){var e;if(this.sample_sizes=[],0===this.version)for(this.sample_size=t.readUint32(),this.sample_count=t.readUint32(),e=0;e<this.sample_count;e++)0===this.sample_size?this.sample_sizes.push(t.readUint32()):this.sample_sizes[e]=this.sample_size}),BoxParser.createFullBoxCtor("stts",function(t){var e,i,r=t.readUint32();if(this.sample_counts=[],this.sample_deltas=[],0===this.version)for(e=0;e<r;e++)this.sample_counts.push(t.readUint32()),(i=t.readInt32())<0&&(Log.warn("BoxParser","File uses negative stts sample delta, using value 1 instead, sync may be lost!"),i=1),this.sample_deltas.push(i)}),BoxParser.createFullBoxCtor("stvi",function(t){var e=t.readUint32();this.single_view_allowed=3&e,this.stereo_scheme=t.readUint32();var i,e=t.readUint32();for(this.stereo_indication_type=t.readString(e),this.boxes=[];t.getPosition()<this.start+this.size;){if((i=BoxParser.parseOneBox(t,!1,this.size-(t.getPosition()-this.start))).code!==BoxParser.OK)return;i=i.box,this.boxes.push(i),this[i.type]=i}}),BoxParser.createBoxCtor("styp",function(t){BoxParser.ftypBox.prototype.parse.call(this,t)}),BoxParser.createFullBoxCtor("stz2",function(t){var e,i;if(this.sample_sizes=[],0===this.version)if(this.reserved=t.readUint24(),this.field_size=t.readUint8(),i=t.readUint32(),4===this.field_size)for(e=0;e<i;e+=2){var r=t.readUint8();this.sample_sizes[e]=r>>4&15,this.sample_sizes[e+1]=15&r}else if(8===this.field_size)for(e=0;e<i;e++)this.sample_sizes[e]=t.readUint8();else if(16===this.field_size)for(e=0;e<i;e++)this.sample_sizes[e]=t.readUint16();else Log.error("BoxParser","Error in length field in stz2 box")}),BoxParser.createFullBoxCtor("subs",function(t){var e,i,r,s=t.readUint32();for(this.entries=[],e=0;e<s;e++){var a={};if((this.entries[e]=a).sample_delta=t.readUint32(),a.subsamples=[],0<(r=t.readUint16()))for(i=0;i<r;i++){var n={};a.subsamples.push(n),1==this.version?n.size=t.readUint32():n.size=t.readUint16(),n.priority=t.readUint8(),n.discardable=t.readUint8(),n.codec_specific_parameters=t.readUint32()}}}),BoxParser.createFullBoxCtor("tenc",function(t){var e;t.readUint8(),0===this.version?t.readUint8():(e=t.readUint8(),this.default_crypt_byte_block=e>>4&15,this.default_skip_byte_block=15&e),this.default_isProtected=t.readUint8(),this.default_Per_Sample_IV_Size=t.readUint8(),this.default_KID=BoxParser.parseHex16(t),1===this.default_isProtected&&0===this.default_Per_Sample_IV_Size&&(this.default_constant_IV_size=t.readUint8(),this.default_constant_IV=t.readUint8Array(this.default_constant_IV_size))}),BoxParser.createFullBoxCtor("tfdt",function(t){1==this.version?this.baseMediaDecodeTime=t.readUint64():this.baseMediaDecodeTime=t.readUint32()}),BoxParser.createFullBoxCtor("tfhd",function(t){var e=0;this.track_id=t.readUint32(),this.size-this.hdr_size>e&&this.flags&BoxParser.TFHD_FLAG_BASE_DATA_OFFSET?(this.base_data_offset=t.readUint64(),e+=8):this.base_data_offset=0,this.size-this.hdr_size>e&&this.flags&BoxParser.TFHD_FLAG_SAMPLE_DESC?(this.default_sample_description_index=t.readUint32(),e+=4):this.default_sample_description_index=0,this.size-this.hdr_size>e&&this.flags&BoxParser.TFHD_FLAG_SAMPLE_DUR?(this.default_sample_duration=t.readUint32(),e+=4):this.default_sample_duration=0,this.size-this.hdr_size>e&&this.flags&BoxParser.TFHD_FLAG_SAMPLE_SIZE?(this.default_sample_size=t.readUint32(),e+=4):this.default_sample_size=0,this.size-this.hdr_size>e&&this.flags&BoxParser.TFHD_FLAG_SAMPLE_FLAGS?(this.default_sample_flags=t.readUint32(),e+=4):this.default_sample_flags=0}),BoxParser.createFullBoxCtor("tfra",function(t){this.track_ID=t.readUint32(),t.readUint24();var e=t.readUint8();this.length_size_of_traf_num=e>>4&3,this.length_size_of_trun_num=e>>2&3,this.length_size_of_sample_num=3&e,this.entries=[];for(var i=t.readUint32(),r=0;r<i;r++)1===this.version?(this.time=t.readUint64(),this.moof_offset=t.readUint64()):(this.time=t.readUint32(),this.moof_offset=t.readUint32()),this.traf_number=t["readUint"+8*(this.length_size_of_traf_num+1)](),this.trun_number=t["readUint"+8*(this.length_size_of_trun_num+1)](),this.sample_number=t["readUint"+8*(this.length_size_of_sample_num+1)]()}),BoxParser.createFullBoxCtor("tkhd",function(t){1==this.version?(this.creation_time=t.readUint64(),this.modification_time=t.readUint64(),this.track_id=t.readUint32(),t.readUint32(),this.duration=t.readUint64()):(this.creation_time=t.readUint32(),this.modification_time=t.readUint32(),this.track_id=t.readUint32(),t.readUint32(),this.duration=t.readUint32()),t.readUint32Array(2),this.layer=t.readInt16(),this.alternate_group=t.readInt16(),this.volume=t.readInt16()>>8,t.readUint16(),this.matrix=t.readInt32Array(9),this.width=t.readUint32(),this.height=t.readUint32()}),BoxParser.createBoxCtor("tmax",function(t){this.time=t.readUint32()}),BoxParser.createBoxCtor("tmin",function(t){this.time=t.readUint32()}),BoxParser.createBoxCtor("totl",function(t){this.bytessent=t.readUint32()}),BoxParser.createBoxCtor("tpay",function(t){this.bytessent=t.readUint32()}),BoxParser.createBoxCtor("tpyl",function(t){this.bytessent=t.readUint64()}),BoxParser.TrackGroupTypeBox.prototype.parse=function(t){this.parseFullHeader(t),this.track_group_id=t.readUint32()},BoxParser.createTrackGroupCtor("msrc"),BoxParser.TrackReferenceTypeBox=function(t,e,i,r){BoxParser.Box.call(this,t,e),this.hdr_size=i,this.start=r},BoxParser.TrackReferenceTypeBox.prototype=new BoxParser.Box,BoxParser.TrackReferenceTypeBox.prototype.parse=function(t){this.track_ids=t.readUint32Array((this.size-this.hdr_size)/4)},BoxParser.trefBox.prototype.parse=function(t){for(var e;t.getPosition()<this.start+this.size;){if((e=BoxParser.parseOneBox(t,!0,this.size-(t.getPosition()-this.start))).code!==BoxParser.OK)return;(e=new BoxParser.TrackReferenceTypeBox(e.type,e.size,e.hdr_size,e.start)).write===BoxParser.Box.prototype.write&&"mdat"!==e.type&&(Log.info("BoxParser","TrackReference "+e.type+" box writing not yet implemented, keeping unparsed data in memory for later write"),e.parseDataAndRewind(t)),e.parse(t),this.boxes.push(e)}},BoxParser.createFullBoxCtor("trep",function(t){for(this.track_ID=t.readUint32(),this.boxes=[];t.getPosition()<this.start+this.size;){if(ret=BoxParser.parseOneBox(t,!1,this.size-(t.getPosition()-this.start)),ret.code!==BoxParser.OK)return;box=ret.box,this.boxes.push(box)}}),BoxParser.createFullBoxCtor("trex",function(t){this.track_id=t.readUint32(),this.default_sample_description_index=t.readUint32(),this.default_sample_duration=t.readUint32(),this.default_sample_size=t.readUint32(),this.default_sample_flags=t.readUint32()}),BoxParser.createBoxCtor("trpy",function(t){this.bytessent=t.readUint64()}),BoxParser.createFullBoxCtor("trun",function(t){var e=0;if(this.sample_count=t.readUint32(),e+=4,this.size-this.hdr_size>e&&this.flags&BoxParser.TRUN_FLAGS_DATA_OFFSET?(this.data_offset=t.readInt32(),e+=4):this.data_offset=0,this.size-this.hdr_size>e&&this.flags&BoxParser.TRUN_FLAGS_FIRST_FLAG?(this.first_sample_flags=t.readUint32(),e+=4):this.first_sample_flags=0,this.sample_duration=[],this.sample_size=[],this.sample_flags=[],this.sample_composition_time_offset=[],this.size-this.hdr_size>e)for(var i=0;i<this.sample_count;i++)this.flags&BoxParser.TRUN_FLAGS_DURATION&&(this.sample_duration[i]=t.readUint32()),this.flags&BoxParser.TRUN_FLAGS_SIZE&&(this.sample_size[i]=t.readUint32()),this.flags&BoxParser.TRUN_FLAGS_FLAGS&&(this.sample_flags[i]=t.readUint32()),this.flags&BoxParser.TRUN_FLAGS_CTS_OFFSET&&(0===this.version?this.sample_composition_time_offset[i]=t.readUint32():this.sample_composition_time_offset[i]=t.readInt32())}),BoxParser.createFullBoxCtor("tsel",function(t){this.switch_group=t.readUint32();var e=(this.size-this.hdr_size-4)/4;this.attribute_list=[];for(var i=0;i<e;i++)this.attribute_list[i]=t.readUint32()}),BoxParser.createFullBoxCtor("txtC",function(t){this.config=t.readCString()}),BoxParser.createFullBoxCtor("url ",function(t){1!==this.flags&&(this.location=t.readCString())}),BoxParser.createFullBoxCtor("urn ",function(t){this.name=t.readCString(),0<this.size-this.hdr_size-this.name.length-1&&(this.location=t.readCString())}),BoxParser.createUUIDBox("a5d40b30e81411ddba2f0800200c9a66",!0,!1,function(t){this.LiveServerManifest=t.readString(this.size-this.hdr_size).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;")}),BoxParser.createUUIDBox("d08a4f1810f34a82b6c832d8aba183d3",!0,!1,function(t){this.system_id=BoxParser.parseHex16(t);var e=t.readUint32();0<e&&(this.data=t.readUint8Array(e))}),BoxParser.createUUIDBox("a2394f525a9b4f14a2446c427c648df4",!0,!1),BoxParser.createUUIDBox("8974dbce7be74c5184f97148f9882554",!0,!1,function(t){this.default_AlgorithmID=t.readUint24(),this.default_IV_size=t.readUint8(),this.default_KID=BoxParser.parseHex16(t)}),BoxParser.createUUIDBox("d4807ef2ca3946958e5426cb9e46a79f",!0,!1,function(t){this.fragment_count=t.readUint8(),this.entries=[];for(var e=0;e<this.fragment_count;e++){var i={},r=0,s=0,s=1===this.version?(r=t.readUint64(),t.readUint64()):(r=t.readUint32(),t.readUint32());i.absolute_time=r,i.absolute_duration=s,this.entries.push(i)}}),BoxParser.createUUIDBox("6d1d9b0542d544e680e2141daff757b2",!0,!1,function(t){1===this.version?(this.absolute_time=t.readUint64(),this.duration=t.readUint64()):(this.absolute_time=t.readUint32(),this.duration=t.readUint32())}),BoxParser.createFullBoxCtor("vmhd",function(t){this.graphicsmode=t.readUint16(),this.opcolor=t.readUint16Array(3)}),BoxParser.createFullBoxCtor("vpcC",function(t){var e;1===this.version?(this.profile=t.readUint8(),this.level=t.readUint8(),e=t.readUint8(),this.bitDepth=e>>4,this.chromaSubsampling=e>>1&7,this.videoFullRangeFlag=1&e,this.colourPrimaries=t.readUint8(),this.transferCharacteristics=t.readUint8(),this.matrixCoefficients=t.readUint8()):(this.profile=t.readUint8(),this.level=t.readUint8(),e=t.readUint8(),this.bitDepth=e>>4&15,this.colorSpace=15&e,e=t.readUint8(),this.chromaSubsampling=e>>4&15,this.transferFunction=e>>1&7,this.videoFullRangeFlag=1&e),this.codecIntializationDataSize=t.readUint16(),this.codecIntializationData=t.readUint8Array(this.codecIntializationDataSize)}),BoxParser.createBoxCtor("vttC",function(t){this.text=t.readString(this.size-this.hdr_size)}),BoxParser.createFullBoxCtor("vvcC",function(t){var e,i={held_bits:void 0,num_held_bits:0,stream_read_1_bytes:function(t){this.held_bits=t.readUint8(),this.num_held_bits=8},stream_read_2_bytes:function(t){this.held_bits=t.readUint16(),this.num_held_bits=16},extract_bits:function(t){var e=this.held_bits>>this.num_held_bits-t&(1<<t)-1;return this.num_held_bits-=t,e}};if(i.stream_read_1_bytes(t),i.extract_bits(5),this.lengthSizeMinusOne=i.extract_bits(2),this.ptl_present_flag=i.extract_bits(1),this.ptl_present_flag){if(i.stream_read_2_bytes(t),this.ols_idx=i.extract_bits(9),this.num_sublayers=i.extract_bits(3),this.constant_frame_rate=i.extract_bits(2),this.chroma_format_idc=i.extract_bits(2),i.stream_read_1_bytes(t),this.bit_depth_minus8=i.extract_bits(3),i.extract_bits(5),i.stream_read_2_bytes(t),i.extract_bits(2),this.num_bytes_constraint_info=i.extract_bits(6),this.general_profile_idc=i.extract_bits(7),this.general_tier_flag=i.extract_bits(1),this.general_level_idc=t.readUint8(),i.stream_read_1_bytes(t),this.ptl_frame_only_constraint_flag=i.extract_bits(1),this.ptl_multilayer_enabled_flag=i.extract_bits(1),this.general_constraint_info=new Uint8Array(this.num_bytes_constraint_info),this.num_bytes_constraint_info){for(o=0;o<this.num_bytes_constraint_info-1;o++){var r=i.extract_bits(6);i.stream_read_1_bytes(t);var s=i.extract_bits(2);this.general_constraint_info[o]=r<<2|s}this.general_constraint_info[this.num_bytes_constraint_info-1]=i.extract_bits(6)}else i.extract_bits(6);for(i.stream_read_1_bytes(t),this.ptl_sublayer_present_mask=0,e=this.num_sublayers-2;0<=e;--e){var a=i.extract_bits(1);this.ptl_sublayer_present_mask|=a<<e}for(e=this.num_sublayers;e<=8&&1<this.num_sublayers;++e)i.extract_bits(1);for(e=this.num_sublayers-2;0<=e;--e)this.ptl_sublayer_present_mask&1<<e&&(this.sublayer_level_idc[e]=t.readUint8());if(this.ptl_num_sub_profiles=t.readUint8(),this.general_sub_profile_idc=[],this.ptl_num_sub_profiles)for(o=0;o<this.ptl_num_sub_profiles;o++)this.general_sub_profile_idc.push(t.readUint32());this.max_picture_width=t.readUint16(),this.max_picture_height=t.readUint16(),this.avg_frame_rate=t.readUint16()}this.nalu_arrays=[];for(var n=t.readUint8(),o=0;o<n;o++){var h=[];this.nalu_arrays.push(h),i.stream_read_1_bytes(t),h.completeness=i.extract_bits(1),i.extract_bits(2),h.nalu_type=i.extract_bits(5);var d=1;for(13!=h.nalu_type&&12!=h.nalu_type&&(d=t.readUint16()),e=0;e<d;e++){var l=t.readUint16();h.push({data:t.readUint8Array(l),length:l})}}}),BoxParser.createFullBoxCtor("vvnC",function(t){var e=strm.readUint8();this.lengthSizeMinusOne=3&e}),BoxParser.SampleEntry.prototype.isVideo=function(){return!1},BoxParser.SampleEntry.prototype.isAudio=function(){return!1},BoxParser.SampleEntry.prototype.isSubtitle=function(){return!1},BoxParser.SampleEntry.prototype.isMetadata=function(){return!1},BoxParser.SampleEntry.prototype.isHint=function(){return!1},BoxParser.SampleEntry.prototype.getCodec=function(){return this.type.replace(".","")},BoxParser.SampleEntry.prototype.getWidth=function(){return""},BoxParser.SampleEntry.prototype.getHeight=function(){return""},BoxParser.SampleEntry.prototype.getChannelCount=function(){return""},BoxParser.SampleEntry.prototype.getSampleRate=function(){return""},BoxParser.SampleEntry.prototype.getSampleSize=function(){return""},BoxParser.VisualSampleEntry.prototype.isVideo=function(){return!0},BoxParser.VisualSampleEntry.prototype.getWidth=function(){return this.width},BoxParser.VisualSampleEntry.prototype.getHeight=function(){return this.height},BoxParser.AudioSampleEntry.prototype.isAudio=function(){return!0},BoxParser.AudioSampleEntry.prototype.getChannelCount=function(){return this.channel_count},BoxParser.AudioSampleEntry.prototype.getSampleRate=function(){return this.samplerate},BoxParser.AudioSampleEntry.prototype.getSampleSize=function(){return this.samplesize},BoxParser.SubtitleSampleEntry.prototype.isSubtitle=function(){return!0},BoxParser.MetadataSampleEntry.prototype.isMetadata=function(){return!0},BoxParser.decimalToHex=function(t,e){var i=Number(t).toString(16);for(e=null==e?e=2:e;i.length<e;)i="0"+i;return i},BoxParser.avc1SampleEntry.prototype.getCodec=BoxParser.avc2SampleEntry.prototype.getCodec=BoxParser.avc3SampleEntry.prototype.getCodec=BoxParser.avc4SampleEntry.prototype.getCodec=function(){var t=BoxParser.SampleEntry.prototype.getCodec.call(this);return this.avcC?t+"."+BoxParser.decimalToHex(this.avcC.AVCProfileIndication)+BoxParser.decimalToHex(this.avcC.profile_compatibility)+BoxParser.decimalToHex(this.avcC.AVCLevelIndication):t},BoxParser.hev1SampleEntry.prototype.getCodec=BoxParser.hvc1SampleEntry.prototype.getCodec=function(){var t=BoxParser.SampleEntry.prototype.getCodec.call(this);if(this.hvcC){switch(t+=".",this.hvcC.general_profile_space){case 0:t+="";break;case 1:t+="A";break;case 2:t+="B";break;case 3:t+="C"}t+=this.hvcC.general_profile_idc,t+=".";for(var e=this.hvcC.general_profile_compatibility,i=0,r=0;r<32&&(i|=1&e,31!=r);r++)i<<=1,e>>=1;t+=BoxParser.decimalToHex(i,0),t+=".",0===this.hvcC.general_tier_flag?t+="L":t+="H",t+=this.hvcC.general_level_idc;var s=!1,a="";for(r=5;0<=r;r--)(this.hvcC.general_constraint_indicator[r]||s)&&(a="."+BoxParser.decimalToHex(this.hvcC.general_constraint_indicator[r],0)+a,s=!0);t+=a}return t},BoxParser.vvc1SampleEntry.prototype.getCodec=BoxParser.vvi1SampleEntry.prototype.getCodec=function(){var t=BoxParser.SampleEntry.prototype.getCodec.call(this);if(this.vvcC){t+="."+this.vvcC.general_profile_idc,this.vvcC.general_tier_flag?t+=".H":t+=".L",t+=this.vvcC.general_level_idc;var e="";if(this.vvcC.general_constraint_info){var i,r=[],s=0;for(s|=this.vvcC.ptl_frame_only_constraint<<7,s|=this.vvcC.ptl_multilayer_enabled<<6,h=0;h<this.vvcC.general_constraint_info.length;++h)s|=this.vvcC.general_constraint_info[h]>>2&63,r.push(s),s&&(i=h),s=this.vvcC.general_constraint_info[h]>>2&3;if(void 0===i)e=".CA";else{e=".C";for(var a="ABCDEFGHIJKLMNOPQRSTUVWXYZ234567",n=0,o=0,h=0;h<=i;++h)for(n=n<<8|r[h],o+=8;5<=o;)e+=a[n>>o-5&31],n&=(1<<(o-=5))-1;o&&(e+=a[31&(n<<=5-o)])}}t+=e}return t},BoxParser.mp4aSampleEntry.prototype.getCodec=function(){var t=BoxParser.SampleEntry.prototype.getCodec.call(this);if(this.esds&&this.esds.esd){var e=this.esds.esd.getOTI(),i=this.esds.esd.getAudioConfig();return t+"."+BoxParser.decimalToHex(e)+(i?"."+i:"")}return t},BoxParser.stxtSampleEntry.prototype.getCodec=function(){var t=BoxParser.SampleEntry.prototype.getCodec.call(this);return this.mime_format?t+"."+this.mime_format:t},BoxParser.vp08SampleEntry.prototype.getCodec=BoxParser.vp09SampleEntry.prototype.getCodec=function(){var t=BoxParser.SampleEntry.prototype.getCodec.call(this),e=this.vpcC.level;0==e&&(e="00");var i=this.vpcC.bitDepth;return 8==i&&(i="08"),t+".0"+this.vpcC.profile+"."+e+"."+i},BoxParser.av01SampleEntry.prototype.getCodec=function(){var t,e=BoxParser.SampleEntry.prototype.getCodec.call(this),i=this.av1C.seq_level_idx_0;return i<10&&(i="0"+i),2===this.av1C.seq_profile&&1===this.av1C.high_bitdepth?t=1===this.av1C.twelve_bit?"12":"10":this.av1C.seq_profile<=2&&(t=1===this.av1C.high_bitdepth?"10":"08"),e+"."+this.av1C.seq_profile+"."+i+(this.av1C.seq_tier_0?"H":"M")+"."+t},BoxParser.Box.prototype.writeHeader=function(t,e){this.size+=8,this.size>MAX_SIZE&&(this.size+=8),"uuid"===this.type&&(this.size+=16),Log.debug("BoxWriter","Writing box "+this.type+" of size: "+this.size+" at position "+t.getPosition()+(e||"")),this.size>MAX_SIZE?t.writeUint32(1):(this.sizePosition=t.getPosition(),t.writeUint32(this.size)),t.writeString(this.type,null,4),"uuid"===this.type&&t.writeUint8Array(this.uuid),this.size>MAX_SIZE&&t.writeUint64(this.size)},BoxParser.FullBox.prototype.writeHeader=function(t){this.size+=4,BoxParser.Box.prototype.writeHeader.call(this,t," v="+this.version+" f="+this.flags),t.writeUint8(this.version),t.writeUint24(this.flags)},BoxParser.Box.prototype.write=function(t){"mdat"===this.type?this.data&&(this.size=this.data.length,this.writeHeader(t),t.writeUint8Array(this.data)):(this.size=this.data?this.data.length:0,this.writeHeader(t),this.data&&t.writeUint8Array(this.data))},BoxParser.ContainerBox.prototype.write=function(t){this.size=0,this.writeHeader(t);for(var e=0;e<this.boxes.length;e++)this.boxes[e]&&(this.boxes[e].write(t),this.size+=this.boxes[e].size);Log.debug("BoxWriter","Adjusting box "+this.type+" with new size "+this.size),t.adjustUint32(this.sizePosition,this.size)},BoxParser.TrackReferenceTypeBox.prototype.write=function(t){this.size=4*this.track_ids.length,this.writeHeader(t),t.writeUint32Array(this.track_ids)},BoxParser.avcCBox.prototype.write=function(t){var e;for(this.size=7,e=0;e<this.SPS.length;e++)this.size+=2+this.SPS[e].length;for(e=0;e<this.PPS.length;e++)this.size+=2+this.PPS[e].length;for(this.ext&&(this.size+=this.ext.length),this.writeHeader(t),t.writeUint8(this.configurationVersion),t.writeUint8(this.AVCProfileIndication),t.writeUint8(this.profile_compatibility),t.writeUint8(this.AVCLevelIndication),t.writeUint8(this.lengthSizeMinusOne+252),t.writeUint8(this.SPS.length+224),e=0;e<this.SPS.length;e++)t.writeUint16(this.SPS[e].length),t.writeUint8Array(this.SPS[e].nalu);for(t.writeUint8(this.PPS.length),e=0;e<this.PPS.length;e++)t.writeUint16(this.PPS[e].length),t.writeUint8Array(this.PPS[e].nalu);this.ext&&t.writeUint8Array(this.ext)},BoxParser.co64Box.prototype.write=function(t){var e;for(this.version=0,this.flags=0,this.size=4+8*this.chunk_offsets.length,this.writeHeader(t),t.writeUint32(this.chunk_offsets.length),e=0;e<this.chunk_offsets.length;e++)t.writeUint64(this.chunk_offsets[e])},BoxParser.cslgBox.prototype.write=function(t){this.version=0,this.flags=0,this.size=20,this.writeHeader(t),t.writeInt32(this.compositionToDTSShift),t.writeInt32(this.leastDecodeToDisplayDelta),t.writeInt32(this.greatestDecodeToDisplayDelta),t.writeInt32(this.compositionStartTime),t.writeInt32(this.compositionEndTime)},BoxParser.cttsBox.prototype.write=function(t){var e;for(this.version=0,this.flags=0,this.size=4+8*this.sample_counts.length,this.writeHeader(t),t.writeUint32(this.sample_counts.length),e=0;e<this.sample_counts.length;e++)t.writeUint32(this.sample_counts[e]),1===this.version?t.writeInt32(this.sample_offsets[e]):t.writeUint32(this.sample_offsets[e])},BoxParser.drefBox.prototype.write=function(t){this.version=0,this.flags=0,this.size=4,this.writeHeader(t),t.writeUint32(this.entries.length);for(var e=0;e<this.entries.length;e++)this.entries[e].write(t),this.size+=this.entries[e].size;Log.debug("BoxWriter","Adjusting box "+this.type+" with new size "+this.size),t.adjustUint32(this.sizePosition,this.size)},BoxParser.elngBox.prototype.write=function(t){this.version=0,this.flags=0,this.size=this.extended_language.length,this.writeHeader(t),t.writeString(this.extended_language)},BoxParser.elstBox.prototype.write=function(t){this.version=0,this.flags=0,this.size=4+12*this.entries.length,this.writeHeader(t),t.writeUint32(this.entries.length);for(var e=0;e<this.entries.length;e++){var i=this.entries[e];t.writeUint32(i.segment_duration),t.writeInt32(i.media_time),t.writeInt16(i.media_rate_integer),t.writeInt16(i.media_rate_fraction)}},BoxParser.emsgBox.prototype.write=function(t){this.version=0,this.flags=0,this.size=16+this.message_data.length+(this.scheme_id_uri.length+1)+(this.value.length+1),this.writeHeader(t),t.writeCString(this.scheme_id_uri),t.writeCString(this.value),t.writeUint32(this.timescale),t.writeUint32(this.presentation_time_delta),t.writeUint32(this.event_duration),t.writeUint32(this.id),t.writeUint8Array(this.message_data)},BoxParser.ftypBox.prototype.write=function(t){this.size=8+4*this.compatible_brands.length,this.writeHeader(t),t.writeString(this.major_brand,null,4),t.writeUint32(this.minor_version);for(var e=0;e<this.compatible_brands.length;e++)t.writeString(this.compatible_brands[e],null,4)},BoxParser.hdlrBox.prototype.write=function(t){this.size=20+this.name.length+1,this.version=0,this.flags=0,this.writeHeader(t),t.writeUint32(0),t.writeString(this.handler,null,4),t.writeUint32(0),t.writeUint32(0),t.writeUint32(0),t.writeCString(this.name)},BoxParser.kindBox.prototype.write=function(t){this.version=0,this.flags=0,this.size=this.schemeURI.length+1+(this.value.length+1),this.writeHeader(t),t.writeCString(this.schemeURI),t.writeCString(this.value)},BoxParser.mdhdBox.prototype.write=function(t){this.size=20,this.flags=0,this.version=0,this.writeHeader(t),t.writeUint32(this.creation_time),t.writeUint32(this.modification_time),t.writeUint32(this.timescale),t.writeUint32(this.duration),t.writeUint16(this.language),t.writeUint16(0)},BoxParser.mehdBox.prototype.write=function(t){this.version=0,this.flags=0,this.size=4,this.writeHeader(t),t.writeUint32(this.fragment_duration)},BoxParser.mfhdBox.prototype.write=function(t){this.version=0,this.flags=0,this.size=4,this.writeHeader(t),t.writeUint32(this.sequence_number)},BoxParser.mvhdBox.prototype.write=function(t){this.version=0,this.flags=0,this.size=96,this.writeHeader(t),t.writeUint32(this.creation_time),t.writeUint32(this.modification_time),t.writeUint32(this.timescale),t.writeUint32(this.duration),t.writeUint32(this.rate),t.writeUint16(this.volume<<8),t.writeUint16(0),t.writeUint32(0),t.writeUint32(0),t.writeUint32Array(this.matrix),t.writeUint32(0),t.writeUint32(0),t.writeUint32(0),t.writeUint32(0),t.writeUint32(0),t.writeUint32(0),t.writeUint32(this.next_track_id)},BoxParser.SampleEntry.prototype.writeHeader=function(t){this.size=8,BoxParser.Box.prototype.writeHeader.call(this,t),t.writeUint8(0),t.writeUint8(0),t.writeUint8(0),t.writeUint8(0),t.writeUint8(0),t.writeUint8(0),t.writeUint16(this.data_reference_index)},BoxParser.SampleEntry.prototype.writeFooter=function(t){for(var e=0;e<this.boxes.length;e++)this.boxes[e].write(t),this.size+=this.boxes[e].size;Log.debug("BoxWriter","Adjusting box "+this.type+" with new size "+this.size),t.adjustUint32(this.sizePosition,this.size)},BoxParser.SampleEntry.prototype.write=function(t){this.writeHeader(t),t.writeUint8Array(this.data),this.size+=this.data.length,Log.debug("BoxWriter","Adjusting box "+this.type+" with new size "+this.size),t.adjustUint32(this.sizePosition,this.size)},BoxParser.VisualSampleEntry.prototype.write=function(t){this.writeHeader(t),this.size+=70,t.writeUint16(0),t.writeUint16(0),t.writeUint32(0),t.writeUint32(0),t.writeUint32(0),t.writeUint16(this.width),t.writeUint16(this.height),t.writeUint32(this.horizresolution),t.writeUint32(this.vertresolution),t.writeUint32(0),t.writeUint16(this.frame_count),t.writeUint8(Math.min(31,this.compressorname.length)),t.writeString(this.compressorname,null,31),t.writeUint16(this.depth),t.writeInt16(-1),this.writeFooter(t)},BoxParser.AudioSampleEntry.prototype.write=function(t){this.writeHeader(t),this.size+=20,t.writeUint32(0),t.writeUint32(0),t.writeUint16(this.channel_count),t.writeUint16(this.samplesize),t.writeUint16(0),t.writeUint16(0),t.writeUint32(this.samplerate<<16),this.writeFooter(t)},BoxParser.stppSampleEntry.prototype.write=function(t){this.writeHeader(t),this.size+=this.namespace.length+1+this.schema_location.length+1+this.auxiliary_mime_types.length+1,t.writeCString(this.namespace),t.writeCString(this.schema_location),t.writeCString(this.auxiliary_mime_types),this.writeFooter(t)},BoxParser.SampleGroupEntry.prototype.write=function(t){t.writeUint8Array(this.data)},BoxParser.sbgpBox.prototype.write=function(t){this.version=1,this.flags=0,this.size=12+8*this.entries.length,this.writeHeader(t),t.writeString(this.grouping_type,null,4),t.writeUint32(this.grouping_type_parameter),t.writeUint32(this.entries.length);for(var e=0;e<this.entries.length;e++){var i=this.entries[e];t.writeInt32(i.sample_count),t.writeInt32(i.group_description_index)}},BoxParser.sgpdBox.prototype.write=function(t){var e,i;for(this.flags=0,this.size=12,e=0;e<this.entries.length;e++)i=this.entries[e],1===this.version&&(0===this.default_length&&(this.size+=4),this.size+=i.data.length);for(this.writeHeader(t),t.writeString(this.grouping_type,null,4),1===this.version&&t.writeUint32(this.default_length),2<=this.version&&t.writeUint32(this.default_sample_description_index),t.writeUint32(this.entries.length),e=0;e<this.entries.length;e++)i=this.entries[e],1===this.version&&0===this.default_length&&t.writeUint32(i.description_length),i.write(t)},BoxParser.sidxBox.prototype.write=function(t){this.version=0,this.flags=0,this.size=20+12*this.references.length,this.writeHeader(t),t.writeUint32(this.reference_ID),t.writeUint32(this.timescale),t.writeUint32(this.earliest_presentation_time),t.writeUint32(this.first_offset),t.writeUint16(0),t.writeUint16(this.references.length);for(var e=0;e<this.references.length;e++){var i=this.references[e];t.writeUint32(i.reference_type<<31|i.referenced_size),t.writeUint32(i.subsegment_duration),t.writeUint32(i.starts_with_SAP<<31|i.SAP_type<<28|i.SAP_delta_time)}},BoxParser.smhdBox.prototype.write=function(t){this.version=0,this.flags=1,this.size=4,this.writeHeader(t),t.writeUint16(this.balance),t.writeUint16(0)},BoxParser.stcoBox.prototype.write=function(t){this.version=0,this.flags=0,this.size=4+4*this.chunk_offsets.length,this.writeHeader(t),t.writeUint32(this.chunk_offsets.length),t.writeUint32Array(this.chunk_offsets)},BoxParser.stscBox.prototype.write=function(t){var e;for(this.version=0,this.flags=0,this.size=4+12*this.first_chunk.length,this.writeHeader(t),t.writeUint32(this.first_chunk.length),e=0;e<this.first_chunk.length;e++)t.writeUint32(this.first_chunk[e]),t.writeUint32(this.samples_per_chunk[e]),t.writeUint32(this.sample_description_index[e])},BoxParser.stsdBox.prototype.write=function(t){var e;for(this.version=0,this.flags=0,this.size=0,this.writeHeader(t),t.writeUint32(this.entries.length),this.size+=4,e=0;e<this.entries.length;e++)this.entries[e].write(t),this.size+=this.entries[e].size;Log.debug("BoxWriter","Adjusting box "+this.type+" with new size "+this.size),t.adjustUint32(this.sizePosition,this.size)},BoxParser.stshBox.prototype.write=function(t){var e;for(this.version=0,this.flags=0,this.size=4+8*this.shadowed_sample_numbers.length,this.writeHeader(t),t.writeUint32(this.shadowed_sample_numbers.length),e=0;e<this.shadowed_sample_numbers.length;e++)t.writeUint32(this.shadowed_sample_numbers[e]),t.writeUint32(this.sync_sample_numbers[e])},BoxParser.stssBox.prototype.write=function(t){this.version=0,this.flags=0,this.size=4+4*this.sample_numbers.length,this.writeHeader(t),t.writeUint32(this.sample_numbers.length),t.writeUint32Array(this.sample_numbers)},BoxParser.stszBox.prototype.write=function(t){var e,i=!0;if(this.version=0,(this.flags=0)<this.sample_sizes.length)for(e=0;e+1<this.sample_sizes.length;){if(this.sample_sizes[e+1]!==this.sample_sizes[0]){i=!1;break}e++}else i=!1;this.size=8,i||(this.size+=4*this.sample_sizes.length),this.writeHeader(t),i?t.writeUint32(this.sample_sizes[0]):t.writeUint32(0),t.writeUint32(this.sample_sizes.length),i||t.writeUint32Array(this.sample_sizes)},BoxParser.sttsBox.prototype.write=function(t){var e;for(this.version=0,this.flags=0,this.size=4+8*this.sample_counts.length,this.writeHeader(t),t.writeUint32(this.sample_counts.length),e=0;e<this.sample_counts.length;e++)t.writeUint32(this.sample_counts[e]),t.writeUint32(this.sample_deltas[e])},BoxParser.tfdtBox.prototype.write=function(t){var e=Math.pow(2,32)-1;this.version=this.baseMediaDecodeTime>e?1:0,this.flags=0,this.size=4,1===this.version&&(this.size+=4),this.writeHeader(t),1===this.version?t.writeUint64(this.baseMediaDecodeTime):t.writeUint32(this.baseMediaDecodeTime)},BoxParser.tfhdBox.prototype.write=function(t){this.version=0,this.size=4,this.flags&BoxParser.TFHD_FLAG_BASE_DATA_OFFSET&&(this.size+=8),this.flags&BoxParser.TFHD_FLAG_SAMPLE_DESC&&(this.size+=4),this.flags&BoxParser.TFHD_FLAG_SAMPLE_DUR&&(this.size+=4),this.flags&BoxParser.TFHD_FLAG_SAMPLE_SIZE&&(this.size+=4),this.flags&BoxParser.TFHD_FLAG_SAMPLE_FLAGS&&(this.size+=4),this.writeHeader(t),t.writeUint32(this.track_id),this.flags&BoxParser.TFHD_FLAG_BASE_DATA_OFFSET&&t.writeUint64(this.base_data_offset),this.flags&BoxParser.TFHD_FLAG_SAMPLE_DESC&&t.writeUint32(this.default_sample_description_index),this.flags&BoxParser.TFHD_FLAG_SAMPLE_DUR&&t.writeUint32(this.default_sample_duration),this.flags&BoxParser.TFHD_FLAG_SAMPLE_SIZE&&t.writeUint32(this.default_sample_size),this.flags&BoxParser.TFHD_FLAG_SAMPLE_FLAGS&&t.writeUint32(this.default_sample_flags)},BoxParser.tkhdBox.prototype.write=function(t){this.version=0,this.size=80,this.writeHeader(t),t.writeUint32(this.creation_time),t.writeUint32(this.modification_time),t.writeUint32(this.track_id),t.writeUint32(0),t.writeUint32(this.duration),t.writeUint32(0),t.writeUint32(0),t.writeInt16(this.layer),t.writeInt16(this.alternate_group),t.writeInt16(this.volume<<8),t.writeUint16(0),t.writeInt32Array(this.matrix),t.writeUint32(this.width),t.writeUint32(this.height)},BoxParser.trexBox.prototype.write=function(t){this.version=0,this.flags=0,this.size=20,this.writeHeader(t),t.writeUint32(this.track_id),t.writeUint32(this.default_sample_description_index),t.writeUint32(this.default_sample_duration),t.writeUint32(this.default_sample_size),t.writeUint32(this.default_sample_flags)},BoxParser.trunBox.prototype.write=function(t){this.version=0,this.size=4,this.flags&BoxParser.TRUN_FLAGS_DATA_OFFSET&&(this.size+=4),this.flags&BoxParser.TRUN_FLAGS_FIRST_FLAG&&(this.size+=4),this.flags&BoxParser.TRUN_FLAGS_DURATION&&(this.size+=4*this.sample_duration.length),this.flags&BoxParser.TRUN_FLAGS_SIZE&&(this.size+=4*this.sample_size.length),this.flags&BoxParser.TRUN_FLAGS_FLAGS&&(this.size+=4*this.sample_flags.length),this.flags&BoxParser.TRUN_FLAGS_CTS_OFFSET&&(this.size+=4*this.sample_composition_time_offset.length),this.writeHeader(t),t.writeUint32(this.sample_count),this.flags&BoxParser.TRUN_FLAGS_DATA_OFFSET&&(this.data_offset_position=t.getPosition(),t.writeInt32(this.data_offset)),this.flags&BoxParser.TRUN_FLAGS_FIRST_FLAG&&t.writeUint32(this.first_sample_flags);for(var e=0;e<this.sample_count;e++)this.flags&BoxParser.TRUN_FLAGS_DURATION&&t.writeUint32(this.sample_duration[e]),this.flags&BoxParser.TRUN_FLAGS_SIZE&&t.writeUint32(this.sample_size[e]),this.flags&BoxParser.TRUN_FLAGS_FLAGS&&t.writeUint32(this.sample_flags[e]),this.flags&BoxParser.TRUN_FLAGS_CTS_OFFSET&&(0===this.version?t.writeUint32(this.sample_composition_time_offset[e]):t.writeInt32(this.sample_composition_time_offset[e]))},BoxParser["url Box"].prototype.write=function(t){this.version=0,this.location?(this.flags=0,this.size=this.location.length+1):(this.flags=1,this.size=0),this.writeHeader(t),this.location&&t.writeCString(this.location)},BoxParser["urn Box"].prototype.write=function(t){this.version=0,this.flags=0,this.size=this.name.length+1+(this.location?this.location.length+1:0),this.writeHeader(t),t.writeCString(this.name),this.location&&t.writeCString(this.location)},BoxParser.vmhdBox.prototype.write=function(t){this.version=0,this.flags=1,this.size=8,this.writeHeader(t),t.writeUint16(this.graphicsmode),t.writeUint16Array(this.opcolor)},BoxParser.cttsBox.prototype.unpack=function(t){for(var e,i=0,r=0;r<this.sample_counts.length;r++)for(e=0;e<this.sample_counts[r];e++)t[i].pts=t[i].dts+this.sample_offsets[r],i++},BoxParser.sttsBox.prototype.unpack=function(t){for(var e,i=0,r=0;r<this.sample_counts.length;r++)for(e=0;e<this.sample_counts[r];e++)t[i].dts=0===i?0:t[i-1].dts+this.sample_deltas[r],i++},BoxParser.stcoBox.prototype.unpack=function(t){for(var e=0;e<this.chunk_offsets.length;e++)t[e].offset=this.chunk_offsets[e]},BoxParser.stscBox.prototype.unpack=function(t){for(var e,i,r=0,s=0,a=0;a<this.first_chunk.length;a++)for(e=0;e<(a+1<this.first_chunk.length?this.first_chunk[a+1]:1/0);e++)for(s++,i=0;i<this.samples_per_chunk[a];i++){if(!t[r])return;t[r].description_index=this.sample_description_index[a],t[r].chunk_index=s,r++}},BoxParser.stszBox.prototype.unpack=function(t){for(var e=0;e<this.sample_sizes.length;e++)t[e].size=this.sample_sizes[e]},BoxParser.DIFF_BOXES_PROP_NAMES=["boxes","entries","references","subsamples","items","item_infos","extents","associations","subsegments","ranges","seekLists","seekPoints","esd","levels"],BoxParser.DIFF_PRIMITIVE_ARRAY_PROP_NAMES=["compatible_brands","matrix","opcolor","sample_counts","sample_counts","sample_deltas","first_chunk","samples_per_chunk","sample_sizes","chunk_offsets","sample_offsets","sample_description_index","sample_duration"],BoxParser.boxEqualFields=function(t,e){if(t&&!e)return!1;for(var i in t)if(!(-1<BoxParser.DIFF_BOXES_PROP_NAMES.indexOf(i)||t[i]instanceof BoxParser.Box||e[i]instanceof BoxParser.Box||void 0===t[i]||void 0===e[i]||"function"==typeof t[i]||"function"==typeof e[i]||t.subBoxNames&&-1<t.subBoxNames.indexOf(i.slice(0,4))||e.subBoxNames&&-1<e.subBoxNames.indexOf(i.slice(0,4))||"data"===i||"start"===i||"size"===i||"creation_time"===i||"modification_time"===i||-1<BoxParser.DIFF_PRIMITIVE_ARRAY_PROP_NAMES.indexOf(i)||t[i]===e[i]))return!1;return!0},BoxParser.boxEqual=function(t,e){if(!BoxParser.boxEqualFields(t,e))return!1;for(var i=0;i<BoxParser.DIFF_BOXES_PROP_NAMES.length;i++){var r=BoxParser.DIFF_BOXES_PROP_NAMES[i];if(t[r]&&e[r]&&!BoxParser.boxEqual(t[r],e[r]))return!1}return!0};var VTTin4Parser=function(){};VTTin4Parser.prototype.parseSample=function(t){for(var e,i=new MP4BoxStream(t.buffer),r=[];!i.isEos();)(e=BoxParser.parseOneBox(i,!1)).code===BoxParser.OK&&"vttc"===e.box.type&&r.push(e.box);return r},VTTin4Parser.prototype.getText=function(t,e,i){function s(t,e,i){return i=i||"0",(t+="").length>=e?t:new Array(e-t.length+1).join(i)+t}function r(t){var e=Math.floor(t/3600),i=Math.floor((t-3600*e)/60),r=Math.floor(t-3600*e-60*i),t=Math.floor(1e3*(t-3600*e-60*i-r));return s(e,2)+":"+s(i,2)+":"+s(r,2)+"."+s(t,3)}for(var a=this.parseSample(i),n="",o=0;o<a.length;o++){var h=a[o];n+=r(t)+" --\x3e "+r(e)+"\r\n",n+=h.payl.text}return n};var XMLSubtitlein4Parser=function(){};XMLSubtitlein4Parser.prototype.parseSample=function(t){var e,i={resources:[]},r=new MP4BoxStream(t.data.buffer);if(t.subsamples&&0!==t.subsamples.length){if(i.documentString=r.readString(t.subsamples[0].size),1<t.subsamples.length)for(e=1;e<t.subsamples.length;e++)i.resources[e]=r.readUint8Array(t.subsamples[e].size)}else i.documentString=r.readString(t.data.length);return"undefined"!=typeof DOMParser&&(i.document=(new DOMParser).parseFromString(i.documentString,"application/xml")),i};var Textin4Parser=function(){};Textin4Parser.prototype.parseSample=function(t){return new MP4BoxStream(t.data.buffer).readString(t.data.length)},Textin4Parser.prototype.parseConfig=function(t){t=new MP4BoxStream(t.buffer);return t.readUint32(),t.readCString()},"undefined"!=typeof exports&&(exports.XMLSubtitlein4Parser=XMLSubtitlein4Parser,exports.Textin4Parser=Textin4Parser);var ISOFile=function(t){this.stream=t||new MultiBufferStream,this.boxes=[],this.mdats=[],this.moofs=[],this.isProgressive=!1,this.moovStartFound=!1,this.onMoovStart=null,this.moovStartSent=!1,this.onReady=null,this.readySent=!1,this.onSegment=null,this.onSamples=null,this.onError=null,this.sampleListBuilt=!1,this.fragmentedTracks=[],this.extractedTracks=[],this.isFragmentationInitialized=!1,this.sampleProcessingStarted=!1,this.nextMoofNumber=0,this.itemListBuilt=!1,this.onSidx=null,this.sidxSent=!1};ISOFile.prototype.setSegmentOptions=function(t,e,i){var r,s=this.getTrackById(t);s&&(r={},this.fragmentedTracks.push(r),r.id=t,r.user=e,(r.trak=s).nextSample=0,r.segmentStream=null,r.nb_samples=1e3,r.rapAlignement=!0,i&&(i.nbSamples&&(r.nb_samples=i.nbSamples),i.rapAlignement&&(r.rapAlignement=i.rapAlignement)))},ISOFile.prototype.unsetSegmentOptions=function(t){for(var e=-1,i=0;i<this.fragmentedTracks.length;i++)this.fragmentedTracks[i].id==t&&(e=i);-1<e&&this.fragmentedTracks.splice(e,1)},ISOFile.prototype.setExtractionOptions=function(t,e,i){var r,s=this.getTrackById(t);s&&(r={},this.extractedTracks.push(r),r.id=t,r.user=e,(r.trak=s).nextSample=0,r.nb_samples=1e3,r.samples=[],i&&i.nbSamples&&(r.nb_samples=i.nbSamples))},ISOFile.prototype.unsetExtractionOptions=function(t){for(var e=-1,i=0;i<this.extractedTracks.length;i++)this.extractedTracks[i].id==t&&(e=i);-1<e&&this.extractedTracks.splice(e,1)},ISOFile.prototype.parse=function(){var t;if(!this.restoreParsePosition||this.restoreParsePosition())for(;;)if(this.hasIncompleteMdat&&this.hasIncompleteMdat()){if(!this.processIncompleteMdat())return}else if(this.saveParsePosition&&this.saveParsePosition(),(t=BoxParser.parseOneBox(this.stream,!1)).code===BoxParser.ERR_NOT_ENOUGH_DATA){if(!this.processIncompleteBox)return;if(!this.processIncompleteBox(t))return}else{var e,i="uuid"!==(e=t.box).type?e.type:e.uuid;switch(this.boxes.push(e),i){case"mdat":this.mdats.push(e);break;case"moof":this.moofs.push(e);break;case"moov":this.moovStartFound=!0,0===this.mdats.length&&(this.isProgressive=!0);default:void 0!==this[i]&&Log.warn("ISOFile","Duplicate Box of type: "+i+", overriding previous occurrence"),this[i]=e}this.updateUsedBytes&&this.updateUsedBytes(e,t)}},ISOFile.prototype.checkBuffer=function(t){if(null==t)throw"Buffer must be defined and non empty";if(void 0===t.fileStart)throw"Buffer must have a fileStart property";return 0===t.byteLength?(Log.warn("ISOFile","Ignoring empty buffer (fileStart: "+t.fileStart+")"),this.stream.logBufferLevel(),!1):(Log.info("ISOFile","Processing buffer (fileStart: "+t.fileStart+")"),t.usedBytes=0,this.stream.insertBuffer(t),this.stream.logBufferLevel(),!!this.stream.initialized()||(Log.warn("ISOFile","Not ready to start parsing"),!1))},ISOFile.prototype.appendBuffer=function(t,e){var i;if(this.checkBuffer(t))return this.parse(),this.moovStartFound&&!this.moovStartSent&&(this.moovStartSent=!0,this.onMoovStart&&this.onMoovStart()),this.moov?(this.sampleListBuilt||(this.buildSampleLists(),this.sampleListBuilt=!0),this.updateSampleLists(),this.onReady&&!this.readySent&&(this.readySent=!0,this.onReady(this.getInfo())),this.processSamples(e),this.nextSeekPosition?(i=this.nextSeekPosition,this.nextSeekPosition=void 0):i=this.nextParsePosition,this.stream.getEndFilePositionAfter&&(i=this.stream.getEndFilePositionAfter(i))):i=this.nextParsePosition||0,this.sidx&&this.onSidx&&!this.sidxSent&&(this.onSidx(this.sidx),this.sidxSent=!0),this.meta&&(this.flattenItemInfo&&!this.itemListBuilt&&(this.flattenItemInfo(),this.itemListBuilt=!0),this.processItems&&this.processItems(this.onItem)),this.stream.cleanBuffers&&(Log.info("ISOFile","Done processing buffer (fileStart: "+t.fileStart+") - next buffer to fetch should have a fileStart position of "+i),this.stream.logBufferLevel(),this.stream.cleanBuffers(),this.stream.logBufferLevel(!0),Log.info("ISOFile","Sample data size in memory: "+this.getAllocatedSampleDataSize())),i},ISOFile.prototype.getInfo=function(){var t,e,i,r,s,a,n={},o=new Date("1904-01-01T00:00:00Z").getTime();if(this.moov)for(n.hasMoov=!0,n.duration=this.moov.mvhd.duration,n.timescale=this.moov.mvhd.timescale,n.isFragmented=null!=this.moov.mvex,n.isFragmented&&this.moov.mvex.mehd&&(n.fragment_duration=this.moov.mvex.mehd.fragment_duration),n.isProgressive=this.isProgressive,n.hasIOD=null!=this.moov.iods,n.brands=[],n.brands.push(this.ftyp.major_brand),n.brands=n.brands.concat(this.ftyp.compatible_brands),n.created=new Date(o+1e3*this.moov.mvhd.creation_time),n.modified=new Date(o+1e3*this.moov.mvhd.modification_time),n.tracks=[],n.audioTracks=[],n.videoTracks=[],n.subtitleTracks=[],n.metadataTracks=[],n.hintTracks=[],n.otherTracks=[],t=0;t<this.moov.traks.length;t++){if(a=(i=this.moov.traks[t]).mdia.minf.stbl.stsd.entries[0],r={},n.tracks.push(r),r.id=i.tkhd.track_id,r.name=i.mdia.hdlr.name,r.references=[],i.tref)for(e=0;e<i.tref.boxes.length;e++)s={},r.references.push(s),s.type=i.tref.boxes[e].type,s.track_ids=i.tref.boxes[e].track_ids;i.edts&&(r.edits=i.edts.elst.entries),r.created=new Date(o+1e3*i.tkhd.creation_time),r.modified=new Date(o+1e3*i.tkhd.modification_time),r.movie_duration=i.tkhd.duration,r.movie_timescale=n.timescale,r.layer=i.tkhd.layer,r.alternate_group=i.tkhd.alternate_group,r.volume=i.tkhd.volume,r.matrix=i.tkhd.matrix,r.track_width=i.tkhd.width/65536,r.track_height=i.tkhd.height/65536,r.timescale=i.mdia.mdhd.timescale,r.cts_shift=i.mdia.minf.stbl.cslg,r.duration=i.mdia.mdhd.duration,r.samples_duration=i.samples_duration,r.codec=a.getCodec(),r.kind=i.udta&&i.udta.kinds.length?i.udta.kinds[0]:{schemeURI:"",value:""},r.language=i.mdia.elng?i.mdia.elng.extended_language:i.mdia.mdhd.languageString,r.nb_samples=i.samples.length,r.size=i.samples_size,r.bitrate=8*r.size*r.timescale/r.samples_duration,a.isAudio()?(r.type="audio",n.audioTracks.push(r),r.audio={},r.audio.sample_rate=a.getSampleRate(),r.audio.channel_count=a.getChannelCount(),r.audio.sample_size=a.getSampleSize()):a.isVideo()?(r.type="video",n.videoTracks.push(r),r.video={},r.video.width=a.getWidth(),r.video.height=a.getHeight()):a.isSubtitle()?(r.type="subtitles",n.subtitleTracks.push(r)):a.isHint()?(r.type="metadata",n.hintTracks.push(r)):a.isMetadata()?(r.type="metadata",n.metadataTracks.push(r)):(r.type="metadata",n.otherTracks.push(r))}else n.hasMoov=!1;if(n.mime="",n.hasMoov&&n.tracks){for(n.videoTracks&&0<n.videoTracks.length?n.mime+='video/mp4; codecs="':n.audioTracks&&0<n.audioTracks.length?n.mime+='audio/mp4; codecs="':n.mime+='application/mp4; codecs="',t=0;t<n.tracks.length;t++)0!==t&&(n.mime+=","),n.mime+=n.tracks[t].codec;n.mime+='"; profiles="',n.mime+=this.ftyp.compatible_brands.join(),n.mime+='"'}return n},ISOFile.prototype.processSamples=function(t){var e;if(this.sampleProcessingStarted){if(this.isFragmentationInitialized&&null!==this.onSegment)for(e=0;e<this.fragmentedTracks.length;e++)for(var i=this.fragmentedTracks[e],r=i.trak;r.nextSample<r.samples.length&&this.sampleProcessingStarted;){Log.debug("ISOFile","Creating media fragment on track #"+i.id+" for sample "+r.nextSample);var s=this.createFragment(i.id,r.nextSample,i.segmentStream);if(!s)break;if(i.segmentStream=s,r.nextSample++,(r.nextSample%i.nb_samples==0||t||r.nextSample>=r.samples.length)&&(Log.info("ISOFile","Sending fragmented data on track #"+i.id+" for samples ["+Math.max(0,r.nextSample-i.nb_samples)+","+(r.nextSample-1)+"]"),Log.info("ISOFile","Sample data size in memory: "+this.getAllocatedSampleDataSize()),this.onSegment&&this.onSegment(i.id,i.user,i.segmentStream.buffer,r.nextSample,t||r.nextSample>=r.samples.length),i.segmentStream=null,i!==this.fragmentedTracks[e]))break}if(null!==this.onSamples)for(e=0;e<this.extractedTracks.length;e++){var a=this.extractedTracks[e];for(r=a.trak;r.nextSample<r.samples.length&&this.sampleProcessingStarted;){Log.debug("ISOFile","Exporting on track #"+a.id+" sample #"+r.nextSample);var n=this.getSample(r,r.nextSample);if(!n)break;if(r.nextSample++,a.samples.push(n),(r.nextSample%a.nb_samples==0||r.nextSample>=r.samples.length)&&(Log.debug("ISOFile","Sending samples on track #"+a.id+" for sample "+r.nextSample),this.onSamples&&this.onSamples(a.id,a.user,a.samples),a.samples=[],a!==this.extractedTracks[e]))break}}}},ISOFile.prototype.getBox=function(t){t=this.getBoxes(t,!0);return t.length?t[0]:null},ISOFile.prototype.getBoxes=function(t,e){var i=[];return ISOFile._sweep.call(this,t,i,e),i},ISOFile._sweep=function(t,e,i){for(var r in this.type&&this.type==t&&e.push(this),this.boxes){if(e.length&&i)return;ISOFile._sweep.call(this.boxes[r],t,e,i)}},ISOFile.prototype.getTrackSamplesInfo=function(t){t=this.getTrackById(t);if(t)return t.samples},ISOFile.prototype.getTrackSample=function(t,e){t=this.getTrackById(t);return this.getSample(t,e)},ISOFile.prototype.releaseUsedSamples=function(t,e){var i=0,r=this.getTrackById(t);r.lastValidSample||(r.lastValidSample=0);for(var s=r.lastValidSample;s<e;s++)i+=this.releaseSample(r,s);Log.info("ISOFile","Track #"+t+" released samples up to "+e+" (released size: "+i+", remaining: "+this.samplesDataSize+")"),r.lastValidSample=e},ISOFile.prototype.start=function(){this.sampleProcessingStarted=!0,this.processSamples(!1)},ISOFile.prototype.stop=function(){this.sampleProcessingStarted=!1},ISOFile.prototype.flush=function(){Log.info("ISOFile","Flushing remaining samples"),this.updateSampleLists(),this.processSamples(!0),this.stream.cleanBuffers(),this.stream.logBufferLevel(!0)},ISOFile.prototype.seekTrack=function(t,e,i){var r,s,a,n,o=0,h=0;if(0===i.samples.length)return Log.info("ISOFile","No sample in track, cannot seek! Using time "+Log.getDurationString(0,1)+" and offset: 0"),{offset:0,time:0};for(r=0;r<i.samples.length;r++){if(s=i.samples[r],0===r)h=0,n=s.timescale;else if(s.cts>t*s.timescale){h=r-1;break}e&&s.is_sync&&(o=r)}for(e&&(h=o),t=i.samples[h].cts,i.nextSample=h;i.samples[h].alreadyRead===i.samples[h].size&&i.samples[h+1];)h++;return a=i.samples[h].offset+i.samples[h].alreadyRead,Log.info("ISOFile","Seeking to "+(e?"RAP":"")+" sample #"+i.nextSample+" on track "+i.tkhd.track_id+", time "+Log.getDurationString(t,n)+" and offset: "+a),{offset:a,time:t/n}},ISOFile.prototype.seek=function(t,e){var i,r,s=this.moov,a={offset:1/0,time:1/0};if(this.moov){for(r=0;r<s.traks.length;r++)i=s.traks[r],(i=this.seekTrack(t,e,i)).offset<a.offset&&(a.offset=i.offset),i.time<a.time&&(a.time=i.time);return Log.info("ISOFile","Seeking at time "+Log.getDurationString(a.time,1)+" needs a buffer with a fileStart position of "+a.offset),a.offset===1/0?a={offset:this.nextParsePosition,time:0}:a.offset=this.stream.getEndFilePositionAfter(a.offset),Log.info("ISOFile","Adjusted seek position (after checking data already in buffer): "+a.offset),a}throw"Cannot seek: moov not received!"},ISOFile.prototype.equal=function(t){for(var e=0;e<this.boxes.length&&e<t.boxes.length;){var i=this.boxes[e],r=t.boxes[e];if(!BoxParser.boxEqual(i,r))return!1;e++}return!0},"undefined"!=typeof exports&&(exports.ISOFile=ISOFile),ISOFile.prototype.lastBoxStartPosition=0,ISOFile.prototype.parsingMdat=null,ISOFile.prototype.nextParsePosition=0,ISOFile.prototype.discardMdatData=!1,ISOFile.prototype.processIncompleteBox=function(t){var e;return"mdat"===t.type?(e=new BoxParser[t.type+"Box"](t.size),this.parsingMdat=e,this.boxes.push(e),this.mdats.push(e),e.start=t.start,e.hdr_size=t.hdr_size,this.stream.addUsedBytes(e.hdr_size),this.lastBoxStartPosition=e.start+e.size,this.stream.seek(e.start+e.size,!1,this.discardMdatData)?!(this.parsingMdat=null):(this.moovStartFound?this.nextParsePosition=this.stream.findEndContiguousBuf():this.nextParsePosition=e.start+e.size,!1)):("moov"===t.type&&(this.moovStartFound=!0,0===this.mdats.length&&(this.isProgressive=!0)),!!this.stream.mergeNextBuffer&&this.stream.mergeNextBuffer()?(this.nextParsePosition=this.stream.getEndPosition(),!0):(!t.type||this.moovStartFound?this.nextParsePosition=this.stream.getEndPosition():this.nextParsePosition=this.stream.getPosition()+t.size,!1))},ISOFile.prototype.hasIncompleteMdat=function(){return null!==this.parsingMdat},ISOFile.prototype.processIncompleteMdat=function(){var t=this.parsingMdat;return this.stream.seek(t.start+t.size,!1,this.discardMdatData)?(Log.debug("ISOFile","Found 'mdat' end in buffered data"),!(this.parsingMdat=null)):(this.nextParsePosition=this.stream.findEndContiguousBuf(),!1)},ISOFile.prototype.restoreParsePosition=function(){return this.stream.seek(this.lastBoxStartPosition,!0,this.discardMdatData)},ISOFile.prototype.saveParsePosition=function(){this.lastBoxStartPosition=this.stream.getPosition()},ISOFile.prototype.updateUsedBytes=function(t,e){this.stream.addUsedBytes&&("mdat"===t.type?(this.stream.addUsedBytes(t.hdr_size),this.discardMdatData&&this.stream.addUsedBytes(t.size-t.hdr_size)):this.stream.addUsedBytes(t.size))},ISOFile.prototype.add=BoxParser.Box.prototype.add,ISOFile.prototype.addBox=BoxParser.Box.prototype.addBox,ISOFile.prototype.init=function(t){var e=t||{},t=(this.add("ftyp").set("major_brand",e.brands&&e.brands[0]||"iso4").set("minor_version",0).set("compatible_brands",e.brands||["iso4"]),this.add("moov"));return t.add("mvhd").set("timescale",e.timescale||600).set("rate",e.rate||65536).set("creation_time",0).set("modification_time",0).set("duration",e.duration||0).set("volume",e.width?0:256).set("matrix",[65536,0,0,0,65536,0,0,0,1073741824]).set("next_track_id",1),t.add("mvex"),this},ISOFile.prototype.addTrack=function(t){this.moov||this.init(t);var e=t||{};e.width=e.width||320,e.height=e.height||320,e.id=e.id||this.moov.mvhd.next_track_id,e.type=e.type||"avc1";var i=this.moov.add("trak");this.moov.mvhd.next_track_id=e.id+1,i.add("tkhd").set("flags",BoxParser.TKHD_FLAG_ENABLED|BoxParser.TKHD_FLAG_IN_MOVIE|BoxParser.TKHD_FLAG_IN_PREVIEW).set("creation_time",0).set("modification_time",0).set("track_id",e.id).set("duration",e.duration||0).set("layer",e.layer||0).set("alternate_group",0).set("volume",1).set("matrix",[0,0,0,0,0,0,0,0,0]).set("width",e.width<<16).set("height",e.height<<16);t=i.add("mdia");t.add("mdhd").set("creation_time",0).set("modification_time",0).set("timescale",e.timescale||1).set("duration",e.media_duration||0).set("language",e.language||"und"),t.add("hdlr").set("handler",e.hdlr||"vide").set("name",e.name||"Track created with MP4Box.js"),t.add("elng").set("extended_language",e.language||"fr-FR");var r=t.add("minf");if(void 0!==BoxParser[e.type+"SampleEntry"]){var s=new BoxParser[e.type+"SampleEntry"];s.data_reference_index=1;var a,n,o,h="";for(a in BoxParser.sampleEntryCodes)for(var d=BoxParser.sampleEntryCodes[a],l=0;l<d.length;l++)if(-1<d.indexOf(e.type)){h=a;break}switch(h){case"Visual":r.add("vmhd").set("graphicsmode",0).set("opcolor",[0,0,0]),s.set("width",e.width).set("height",e.height).set("horizresolution",72<<16).set("vertresolution",72<<16).set("frame_count",1).set("compressorname",e.type+" Compressor").set("depth",24),e.avcDecoderConfigRecord&&(n=new BoxParser.avcCBox,o=new MP4BoxStream(e.avcDecoderConfigRecord),n.parse(o),s.addBox(n));break;case"Audio":r.add("smhd").set("balance",e.balance||0),s.set("channel_count",e.channel_count||2).set("samplesize",e.samplesize||16).set("samplerate",e.samplerate||65536);break;case"Hint":r.add("hmhd");break;case"Subtitle":r.add("sthd"),"stpp"===e.type&&s.set("namespace",e.namespace||"nonamespace").set("schema_location",e.schema_location||"").set("auxiliary_mime_types",e.auxiliary_mime_types||"");break;case"Metadata":case"System":default:r.add("nmhd")}e.description&&s.addBox(e.description),e.description_boxes&&e.description_boxes.forEach(function(t){s.addBox(t)}),r.add("dinf").add("dref").addEntry((new BoxParser["url Box"]).set("flags",1));t=r.add("stbl");return t.add("stsd").addEntry(s),t.add("stts").set("sample_counts",[]).set("sample_deltas",[]),t.add("stsc").set("first_chunk",[]).set("samples_per_chunk",[]).set("sample_description_index",[]),t.add("stco").set("chunk_offsets",[]),t.add("stsz").set("sample_sizes",[]),this.moov.mvex.add("trex").set("track_id",e.id).set("default_sample_description_index",e.default_sample_description_index||1).set("default_sample_duration",e.default_sample_duration||0).set("default_sample_size",e.default_sample_size||0).set("default_sample_flags",e.default_sample_flags||0),this.buildTrakSampleLists(i),e.id}},BoxParser.Box.prototype.computeSize=function(t){t=t||new DataStream;t.endianness=DataStream.BIG_ENDIAN,this.write(t)},ISOFile.prototype.addSample=function(t,e,i){var r=i||{},i={},t=this.getTrackById(t);if(null!==t){i.number=t.samples.length,i.track_id=t.tkhd.track_id,i.timescale=t.mdia.mdhd.timescale,i.description_index=r.sample_description_index?r.sample_description_index-1:0,i.description=t.mdia.minf.stbl.stsd.entries[i.description_index],i.data=e,i.size=e.byteLength,i.alreadyRead=i.size,i.duration=r.duration||1,i.cts=r.cts||0,i.dts=r.dts||0,i.is_sync=r.is_sync||!1,i.is_leading=r.is_leading||0,i.depends_on=r.depends_on||0,i.is_depended_on=r.is_depended_on||0,i.has_redundancy=r.has_redundancy||0,i.degradation_priority=r.degradation_priority||0,i.offset=0,i.subsamples=r.subsamples,t.samples.push(i),t.samples_size+=i.size,t.samples_duration+=i.duration,t.first_dts||(t.first_dts=r.dts),this.processSamples();r=this.createSingleSampleMoof(i);return this.addBox(r),r.computeSize(),r.trafs[0].truns[0].data_offset=r.size+8,this.add("mdat").data=new Uint8Array(e),i}},ISOFile.prototype.createSingleSampleMoof=function(t){var e=0,e=t.is_sync?1<<25:65536,i=new BoxParser.moofBox;i.add("mfhd").set("sequence_number",this.nextMoofNumber),this.nextMoofNumber++;var r=i.add("traf"),s=this.getTrackById(t.track_id);return r.add("tfhd").set("track_id",t.track_id).set("flags",BoxParser.TFHD_FLAG_DEFAULT_BASE_IS_MOOF),r.add("tfdt").set("baseMediaDecodeTime",t.dts-(s.first_dts||0)),r.add("trun").set("flags",BoxParser.TRUN_FLAGS_DATA_OFFSET|BoxParser.TRUN_FLAGS_DURATION|BoxParser.TRUN_FLAGS_SIZE|BoxParser.TRUN_FLAGS_FLAGS|BoxParser.TRUN_FLAGS_CTS_OFFSET).set("data_offset",0).set("first_sample_flags",0).set("sample_count",1).set("sample_duration",[t.duration]).set("sample_size",[t.size]).set("sample_flags",[e]).set("sample_composition_time_offset",[t.cts-t.dts]),i},ISOFile.prototype.lastMoofIndex=0,ISOFile.prototype.samplesDataSize=0,ISOFile.prototype.resetTables=function(){var t,e;for(this.initial_duration=this.moov.mvhd.duration,t=this.moov.mvhd.duration=0;t<this.moov.traks.length;t++){(e=this.moov.traks[t]).tkhd.duration=0,e.mdia.mdhd.duration=0,(e.mdia.minf.stbl.stco||e.mdia.minf.stbl.co64).chunk_offsets=[],(i=e.mdia.minf.stbl.stsc).first_chunk=[],i.samples_per_chunk=[],i.sample_description_index=[],(e.mdia.minf.stbl.stsz||e.mdia.minf.stbl.stz2).sample_sizes=[],(i=e.mdia.minf.stbl.stts).sample_counts=[],i.sample_deltas=[],(i=e.mdia.minf.stbl.ctts)&&(i.sample_counts=[],i.sample_offsets=[]),i=e.mdia.minf.stbl.stss;var i=e.mdia.minf.stbl.boxes.indexOf(i);-1!=i&&(e.mdia.minf.stbl.boxes[i]=null)}},ISOFile.initSampleGroups=function(t,e,i,r,s){var a,n,o,h;function d(t,e,i){this.grouping_type=t,this.grouping_type_parameter=e,this.sbgp=i,this.last_sample_in_run=-1,this.entry_index=-1}for(e&&(e.sample_groups_info=[]),t.sample_groups_info||(t.sample_groups_info=[]),n=0;n<i.length;n++){for(h=i[n].grouping_type+"/"+i[n].grouping_type_parameter,o=new d(i[n].grouping_type,i[n].grouping_type_parameter,i[n]),e&&(e.sample_groups_info[h]=o),t.sample_groups_info[h]||(t.sample_groups_info[h]=o),a=0;a<r.length;a++)r[a].grouping_type===i[n].grouping_type&&(o.description=r[a],o.description.used=!0);if(s)for(a=0;a<s.length;a++)s[a].grouping_type===i[n].grouping_type&&(o.fragment_description=s[a],o.fragment_description.used=!0,o.is_fragment=!0)}if(e){if(s)for(n=0;n<s.length;n++)!s[n].used&&2<=s[n].version&&(h=s[n].grouping_type+"/0",(o=new d(s[n].grouping_type,0)).is_fragment=!0,e.sample_groups_info[h]||(e.sample_groups_info[h]=o))}else for(n=0;n<r.length;n++)!r[n].used&&2<=r[n].version&&(h=r[n].grouping_type+"/0",o=new d(r[n].grouping_type,0),t.sample_groups_info[h]||(t.sample_groups_info[h]=o))},ISOFile.setSampleGroupProperties=function(t,e,i,r){var s,a,n;for(s in e.sample_groups=[],r)e.sample_groups[s]={},e.sample_groups[s].grouping_type=r[s].grouping_type,e.sample_groups[s].grouping_type_parameter=r[s].grouping_type_parameter,i>=r[s].last_sample_in_run&&(r[s].last_sample_in_run<0&&(r[s].last_sample_in_run=0),r[s].entry_index++,r[s].entry_index<=r[s].sbgp.entries.length-1&&(r[s].last_sample_in_run+=r[s].sbgp.entries[r[s].entry_index].sample_count)),r[s].entry_index<=r[s].sbgp.entries.length-1?e.sample_groups[s].group_description_index=r[s].sbgp.entries[r[s].entry_index].group_description_index:e.sample_groups[s].group_description_index=-1,0!==e.sample_groups[s].group_description_index&&(n=r[s].fragment_description||r[s].description,0<e.sample_groups[s].group_description_index?(a=65535<e.sample_groups[s].group_description_index?(e.sample_groups[s].group_description_index>>16)-1:e.sample_groups[s].group_description_index-1,n&&0<=a&&(e.sample_groups[s].description=n.entries[a])):n&&2<=n.version&&0<n.default_group_description_index&&(e.sample_groups[s].description=n.entries[n.default_group_description_index-1]))},ISOFile.process_sdtp=function(t,e,i){e&&(t?(e.is_leading=t.is_leading[i],e.depends_on=t.sample_depends_on[i],e.is_depended_on=t.sample_is_depended_on[i],e.has_redundancy=t.sample_has_redundancy[i]):(e.is_leading=0,e.depends_on=0,e.is_depended_on=0,e.has_redundancy=0))},ISOFile.prototype.buildSampleLists=function(){for(var t,e=0;e<this.moov.traks.length;e++)t=this.moov.traks[e],this.buildTrakSampleLists(t)},ISOFile.prototype.buildTrakSampleLists=function(t){var e,i,r,s,a,n,o,h,d,l,p,f,u,_,c,m,g,x,y,B,S,P,U,b;if(t.samples=[],t.samples_duration=0,t.samples_size=0,i=t.mdia.minf.stbl.stco||t.mdia.minf.stbl.co64,r=t.mdia.minf.stbl.stsc,s=t.mdia.minf.stbl.stsz||t.mdia.minf.stbl.stz2,a=t.mdia.minf.stbl.stts,n=t.mdia.minf.stbl.ctts,o=t.mdia.minf.stbl.stss,h=t.mdia.minf.stbl.stsd,d=t.mdia.minf.stbl.subs,f=t.mdia.minf.stbl.stdp,l=t.mdia.minf.stbl.sbgps,p=t.mdia.minf.stbl.sgpds,S=B=y=x=-1,b=U=P=0,ISOFile.initSampleGroups(t,null,l,p),void 0!==s){for(e=0;e<s.sample_sizes.length;e++){var v={};v.number=e,v.track_id=t.tkhd.track_id,v.timescale=t.mdia.mdhd.timescale,v.alreadyRead=0,(t.samples[e]=v).size=s.sample_sizes[e],t.samples_size+=v.size,0===e?(_=1,u=0,v.chunk_index=_,v.chunk_run_index=u,g=r.samples_per_chunk[u],m=0,c=u+1<r.first_chunk.length?r.first_chunk[u+1]-1:1/0):e<g?(v.chunk_index=_,v.chunk_run_index=u):(_++,m=0,(v.chunk_index=_)<=c||(c=++u+1<r.first_chunk.length?r.first_chunk[u+1]-1:1/0),v.chunk_run_index=u,g+=r.samples_per_chunk[u]),v.description_index=r.sample_description_index[v.chunk_run_index]-1,v.description=h.entries[v.description_index],v.offset=i.chunk_offsets[v.chunk_index-1]+m,m+=v.size,x<e&&(y++,x<0&&(x=0),x+=a.sample_counts[y]),0<e?(t.samples[e-1].duration=a.sample_deltas[y],t.samples_duration+=t.samples[e-1].duration,v.dts=t.samples[e-1].dts+t.samples[e-1].duration):v.dts=0,n?(B<=e&&(S++,B<0&&(B=0),B+=n.sample_counts[S]),v.cts=t.samples[e].dts+n.sample_offsets[S]):v.cts=v.dts,o?(e==o.sample_numbers[P]-1?(v.is_sync=!0,P++):(v.is_sync=!1,v.degradation_priority=0),d&&d.entries[U].sample_delta+b==e+1&&(v.subsamples=d.entries[U].subsamples,b+=d.entries[U].sample_delta,U++)):v.is_sync=!0,ISOFile.process_sdtp(t.mdia.minf.stbl.sdtp,v,v.number),v.degradation_priority=f?f.priority[e]:0,d&&d.entries[U].sample_delta+b==e&&(v.subsamples=d.entries[U].subsamples,b+=d.entries[U].sample_delta),(0<l.length||0<p.length)&&ISOFile.setSampleGroupProperties(t,v,e,t.sample_groups_info)}0<e&&(t.samples[e-1].duration=Math.max(t.mdia.mdhd.duration-t.samples[e-1].dts,0),t.samples_duration+=t.samples[e-1].duration)}},ISOFile.prototype.updateSampleLists=function(){var t,e,i,r,s,a,n,o,h,d,l,p;if(void 0!==this.moov)for(;this.lastMoofIndex<this.moofs.length;)if(n=this.moofs[this.lastMoofIndex],this.lastMoofIndex++,"moof"==n.type)for(o=n,t=0;t<o.trafs.length;t++){for(h=o.trafs[t],d=this.getTrackById(h.tfhd.track_id),l=this.getTrexById(h.tfhd.track_id),e=h.tfhd.flags&BoxParser.TFHD_FLAG_SAMPLE_DESC?h.tfhd.default_sample_description_index:l?l.default_sample_description_index:1,i=h.tfhd.flags&BoxParser.TFHD_FLAG_SAMPLE_DUR?h.tfhd.default_sample_duration:l?l.default_sample_duration:0,r=h.tfhd.flags&BoxParser.TFHD_FLAG_SAMPLE_SIZE?h.tfhd.default_sample_size:l?l.default_sample_size:0,s=h.tfhd.flags&BoxParser.TFHD_FLAG_SAMPLE_FLAGS?h.tfhd.default_sample_flags:l?l.default_sample_flags:0,(h.sample_number=0)<h.sbgps.length&&ISOFile.initSampleGroups(d,h,h.sbgps,d.mdia.minf.stbl.sgpds,h.sgpds),y=0;y<h.truns.length;y++)for(var f=h.truns[y],u=0;u<f.sample_count;u++){(p={}).moof_number=this.lastMoofIndex,p.number_in_traf=h.sample_number,h.sample_number++,p.number=d.samples.length,h.first_sample_index=d.samples.length,d.samples.push(p),p.track_id=d.tkhd.track_id,p.timescale=d.mdia.mdhd.timescale,p.description_index=e-1,p.description=d.mdia.minf.stbl.stsd.entries[p.description_index],p.size=r,f.flags&BoxParser.TRUN_FLAGS_SIZE&&(p.size=f.sample_size[u]),d.samples_size+=p.size,p.duration=i,f.flags&BoxParser.TRUN_FLAGS_DURATION&&(p.duration=f.sample_duration[u]),d.samples_duration+=p.duration,d.first_traf_merged||0<u?p.dts=d.samples[d.samples.length-2].dts+d.samples[d.samples.length-2].duration:(h.tfdt?p.dts=h.tfdt.baseMediaDecodeTime:p.dts=0,d.first_traf_merged=!0),p.cts=p.dts,f.flags&BoxParser.TRUN_FLAGS_CTS_OFFSET&&(p.cts=p.dts+f.sample_composition_time_offset[u]),g=s,f.flags&BoxParser.TRUN_FLAGS_FLAGS?g=f.sample_flags[u]:0===u&&f.flags&BoxParser.TRUN_FLAGS_FIRST_FLAG&&(g=f.first_sample_flags),p.is_sync=!(g>>16&1),p.is_leading=g>>26&3,p.depends_on=g>>24&3,p.is_depended_on=g>>22&3,p.has_redundancy=g>>20&3,p.degradation_priority=65535&g;var _=!!(h.tfhd.flags&BoxParser.TFHD_FLAG_BASE_DATA_OFFSET),c=!!(h.tfhd.flags&BoxParser.TFHD_FLAG_DEFAULT_BASE_IS_MOOF),m=!!(f.flags&BoxParser.TRUN_FLAGS_DATA_OFFSET),g=0,g=_?h.tfhd.base_data_offset:c||0===y?o.start:a;p.offset=0===y&&0===u?m?g+f.data_offset:g:a,a=p.offset+p.size,(0<h.sbgps.length||0<h.sgpds.length||0<d.mdia.minf.stbl.sbgps.length||0<d.mdia.minf.stbl.sgpds.length)&&ISOFile.setSampleGroupProperties(d,p,p.number_in_traf,h.sample_groups_info)}if(h.subs){d.has_fragment_subsamples=!0;for(var x=h.first_sample_index,y=0;y<h.subs.entries.length;y++)x+=h.subs.entries[y].sample_delta,(p=d.samples[x-1]).subsamples=h.subs.entries[y].subsamples}}},ISOFile.prototype.getSample=function(t,e){var i,r=t.samples[e];if(!this.moov)return null;if(r.data){if(r.alreadyRead==r.size)return r}else r.data=new Uint8Array(r.size),r.alreadyRead=0,this.samplesDataSize+=r.size,Log.debug("ISOFile","Allocating sample #"+e+" on track #"+t.tkhd.track_id+" of size "+r.size+" (total: "+this.samplesDataSize+")");for(;;){var s=this.stream.findPosition(!0,r.offset+r.alreadyRead,!1);if(!(-1<s))return null;s=(i=this.stream.buffers[s]).byteLength-(r.offset+r.alreadyRead-i.fileStart);if(r.size-r.alreadyRead<=s)return Log.debug("ISOFile","Getting sample #"+e+" data (alreadyRead: "+r.alreadyRead+" offset: "+(r.offset+r.alreadyRead-i.fileStart)+" read size: "+(r.size-r.alreadyRead)+" full size: "+r.size+")"),DataStream.memcpy(r.data.buffer,r.alreadyRead,i,r.offset+r.alreadyRead-i.fileStart,r.size-r.alreadyRead),i.usedBytes+=r.size-r.alreadyRead,this.stream.logBufferLevel(),r.alreadyRead=r.size,r;if(0==s)return null;Log.debug("ISOFile","Getting sample #"+e+" partial data (alreadyRead: "+r.alreadyRead+" offset: "+(r.offset+r.alreadyRead-i.fileStart)+" read size: "+s+" full size: "+r.size+")"),DataStream.memcpy(r.data.buffer,r.alreadyRead,i,r.offset+r.alreadyRead-i.fileStart,s),r.alreadyRead+=s,i.usedBytes+=s,this.stream.logBufferLevel()}},ISOFile.prototype.releaseSample=function(t,e){e=t.samples[e];return e.data?(this.samplesDataSize-=e.size,e.data=null,e.alreadyRead=0,e.size):0},ISOFile.prototype.getAllocatedSampleDataSize=function(){return this.samplesDataSize},ISOFile.prototype.getCodecs=function(){for(var t="",e=0;e<this.moov.traks.length;e++)0<e&&(t+=","),t+=this.moov.traks[e].mdia.minf.stbl.stsd.entries[0].getCodec();return t},ISOFile.prototype.getTrexById=function(t){var e;if(!this.moov||!this.moov.mvex)return null;for(e=0;e<this.moov.mvex.trexs.length;e++){var i=this.moov.mvex.trexs[e];if(i.track_id==t)return i}return null},ISOFile.prototype.getTrackById=function(t){if(void 0===this.moov)return null;for(var e=0;e<this.moov.traks.length;e++){var i=this.moov.traks[e];if(i.tkhd.track_id==t)return i}return null},ISOFile.prototype.items=[],ISOFile.prototype.itemsDataSize=0,ISOFile.prototype.flattenItemInfo=function(){var t=this.items,e=this.meta;if(null!=e&&void 0!==e.hdlr&&void 0!==e.iinf){for(h=0;h<e.iinf.item_infos.length;h++)(r={}).id=e.iinf.item_infos[h].item_ID,(t[r.id]=r).ref_to=[],r.name=e.iinf.item_infos[h].item_name,0<e.iinf.item_infos[h].protection_index&&(r.protection=e.ipro.protections[e.iinf.item_infos[h].protection_index-1]),e.iinf.item_infos[h].item_type?r.type=e.iinf.item_infos[h].item_type:r.type="mime",r.content_type=e.iinf.item_infos[h].content_type,r.content_encoding=e.iinf.item_infos[h].content_encoding;if(e.iloc)for(h=0;h<e.iloc.items.length;h++){var i=e.iloc.items[h],r=t[i.item_ID];switch(0!==i.data_reference_index&&(Log.warn("Item storage with reference to other files: not supported"),r.source=e.dinf.boxes[i.data_reference_index-1]),i.construction_method){case 0:break;case 1:case 2:Log.warn("Item storage with construction_method : not supported")}for(r.extents=[],a=r.size=0;a<i.extents.length;a++)r.extents[a]={},r.extents[a].offset=i.extents[a].extent_offset+i.base_offset,r.extents[a].length=i.extents[a].extent_length,r.extents[a].alreadyRead=0,r.size+=r.extents[a].length}if(e.pitm&&(t[e.pitm.item_id].primary=!0),e.iref)for(h=0;h<e.iref.references.length;h++)for(var s=e.iref.references[h],a=0;a<s.references.length;a++)t[s.from_item_ID].ref_to.push({type:s.type,id:s.references[a]});if(e.iprp)for(var n=0;n<e.iprp.ipmas.length;n++)for(var o=e.iprp.ipmas[n],h=0;h<o.associations.length;h++){var d=o.associations[h];for(void 0===(r=t[d.id]).properties&&(r.properties={},r.properties.boxes=[]),a=0;a<d.props.length;a++){var l=d.props[a];0<l.property_index&&l.property_index-1<e.iprp.ipco.boxes.length&&(l=e.iprp.ipco.boxes[l.property_index-1],r.properties[l.type]=l,r.properties.boxes.push(l))}}}},ISOFile.prototype.getItem=function(t){var e,i;if(!this.meta)return null;if(!(i=this.items[t]).data&&i.size)i.data=new Uint8Array(i.size),i.alreadyRead=0,this.itemsDataSize+=i.size,Log.debug("ISOFile","Allocating item #"+t+" of size "+i.size+" (total: "+this.itemsDataSize+")");else if(i.alreadyRead===i.size)return i;for(var r=0;r<i.extents.length;r++){var s=i.extents[r];if(s.alreadyRead!==s.length){var a=this.stream.findPosition(!0,s.offset+s.alreadyRead,!1);if(!(-1<a))return null;a=(e=this.stream.buffers[a]).byteLength-(s.offset+s.alreadyRead-e.fileStart);if(!(s.length-s.alreadyRead<=a))return Log.debug("ISOFile","Getting item #"+t+" extent #"+r+" partial data (alreadyRead: "+s.alreadyRead+" offset: "+(s.offset+s.alreadyRead-e.fileStart)+" read size: "+a+" full extent size: "+s.length+" full item size: "+i.size+")"),DataStream.memcpy(i.data.buffer,i.alreadyRead,e,s.offset+s.alreadyRead-e.fileStart,a),s.alreadyRead+=a,i.alreadyRead+=a,e.usedBytes+=a,this.stream.logBufferLevel(),null;Log.debug("ISOFile","Getting item #"+t+" extent #"+r+" data (alreadyRead: "+s.alreadyRead+" offset: "+(s.offset+s.alreadyRead-e.fileStart)+" read size: "+(s.length-s.alreadyRead)+" full extent size: "+s.length+" full item size: "+i.size+")"),DataStream.memcpy(i.data.buffer,i.alreadyRead,e,s.offset+s.alreadyRead-e.fileStart,s.length-s.alreadyRead),e.usedBytes+=s.length-s.alreadyRead,this.stream.logBufferLevel(),i.alreadyRead+=s.length-s.alreadyRead,s.alreadyRead=s.length}}return i.alreadyRead===i.size?i:null},ISOFile.prototype.releaseItem=function(t){var e=this.items[t];if(e.data){this.itemsDataSize-=e.size,e.data=null;for(var i=e.alreadyRead=0;i<e.extents.length;i++)e.extents[i].alreadyRead=0;return e.size}return 0},ISOFile.prototype.processItems=function(t){for(var e in this.items){var i=this.items[e];this.getItem(i.id),t&&!i.sent&&(t(i),i.sent=!0,i.data=null)}},ISOFile.prototype.hasItem=function(t){for(var e in this.items){var i=this.items[e];if(i.name===t)return i.id}return-1},ISOFile.prototype.getMetaHandler=function(){return this.meta?this.meta.hdlr.handler:null},ISOFile.prototype.getPrimaryItem=function(){return this.meta&&this.meta.pitm?this.getItem(this.meta.pitm.item_id):null},ISOFile.prototype.itemToFragmentedTrackFile=function(t){var e=t||{},i=null;if(null==(i=e.itemId?this.getItem(e.itemId):this.getPrimaryItem()))return null;t=new ISOFile;t.discardMdatData=!1;e={type:i.type,description_boxes:i.properties.boxes};i.properties.ispe&&(e.width=i.properties.ispe.image_width,e.height=i.properties.ispe.image_height);e=t.addTrack(e);return e?(t.addSample(e,i.data),t):null},ISOFile.prototype.write=function(t){for(var e=0;e<this.boxes.length;e++)this.boxes[e].write(t)},ISOFile.prototype.createFragment=function(t,e,i){var r=this.getTrackById(t),t=this.getSample(r,e);if(null==t)return t=r.samples[e],this.nextSeekPosition?this.nextSeekPosition=Math.min(t.offset+t.alreadyRead,this.nextSeekPosition):this.nextSeekPosition=r.samples[e].offset+t.alreadyRead,null;e=i||new DataStream;e.endianness=DataStream.BIG_ENDIAN;i=this.createSingleSampleMoof(t);i.write(e),i.trafs[0].truns[0].data_offset=i.size+8,Log.debug("MP4Box","Adjusting data_offset with new value "+i.trafs[0].truns[0].data_offset),e.adjustUint32(i.trafs[0].truns[0].data_offset_position,i.trafs[0].truns[0].data_offset);i=new BoxParser.mdatBox;return i.data=t.data,i.write(e),e},ISOFile.writeInitializationSegment=function(t,e,i,r){var s;Log.debug("ISOFile","Generating initialization segment");var a=new DataStream;a.endianness=DataStream.BIG_ENDIAN,t.write(a);var n=e.add("mvex");for(i&&n.add("mehd").set("fragment_duration",i),s=0;s<e.traks.length;s++)n.add("trex").set("track_id",e.traks[s].tkhd.track_id).set("default_sample_description_index",1).set("default_sample_duration",r).set("default_sample_size",0).set("default_sample_flags",65536);return e.write(a),a.buffer},ISOFile.prototype.save=function(t){var e=new DataStream;e.endianness=DataStream.BIG_ENDIAN,this.write(e),e.save(t)},ISOFile.prototype.getBuffer=function(){var t=new DataStream;return t.endianness=DataStream.BIG_ENDIAN,this.write(t),t.buffer},ISOFile.prototype.initializeSegmentation=function(){var t,e,i,r;for(null===this.onSegment&&Log.warn("MP4Box","No segmentation callback set!"),this.isFragmentationInitialized||(this.isFragmentationInitialized=!0,this.nextMoofNumber=0,this.resetTables()),e=[],t=0;t<this.fragmentedTracks.length;t++){var s=new BoxParser.moovBox;s.mvhd=this.moov.mvhd,s.boxes.push(s.mvhd),i=this.getTrackById(this.fragmentedTracks[t].id),s.boxes.push(i),s.traks.push(i),(r={}).id=i.tkhd.track_id,r.user=this.fragmentedTracks[t].user,r.buffer=ISOFile.writeInitializationSegment(this.ftyp,s,this.moov.mvex&&this.moov.mvex.mehd?this.moov.mvex.mehd.fragment_duration:void 0,0<this.moov.traks[t].samples.length?this.moov.traks[t].samples[0].duration:0),e.push(r)}return e},BoxParser.Box.prototype.printHeader=function(t){this.size+=8,this.size>MAX_SIZE&&(this.size+=8),"uuid"===this.type&&(this.size+=16),t.log(t.indent+"size:"+this.size),t.log(t.indent+"type:"+this.type)},BoxParser.FullBox.prototype.printHeader=function(t){this.size+=4,BoxParser.Box.prototype.printHeader.call(this,t),t.log(t.indent+"version:"+this.version),t.log(t.indent+"flags:"+this.flags)},BoxParser.Box.prototype.print=function(t){this.printHeader(t)},BoxParser.ContainerBox.prototype.print=function(t){this.printHeader(t);for(var e,i=0;i<this.boxes.length;i++)this.boxes[i]&&(e=t.indent,t.indent+=" ",this.boxes[i].print(t),t.indent=e)},ISOFile.prototype.print=function(t){t.indent="";for(var e=0;e<this.boxes.length;e++)this.boxes[e]&&this.boxes[e].print(t)},BoxParser.mvhdBox.prototype.print=function(t){BoxParser.FullBox.prototype.printHeader.call(this,t),t.log(t.indent+"creation_time: "+this.creation_time),t.log(t.indent+"modification_time: "+this.modification_time),t.log(t.indent+"timescale: "+this.timescale),t.log(t.indent+"duration: "+this.duration),t.log(t.indent+"rate: "+this.rate),t.log(t.indent+"volume: "+(this.volume>>8)),t.log(t.indent+"matrix: "+this.matrix.join(", ")),t.log(t.indent+"next_track_id: "+this.next_track_id)},BoxParser.tkhdBox.prototype.print=function(t){BoxParser.FullBox.prototype.printHeader.call(this,t),t.log(t.indent+"creation_time: "+this.creation_time),t.log(t.indent+"modification_time: "+this.modification_time),t.log(t.indent+"track_id: "+this.track_id),t.log(t.indent+"duration: "+this.duration),t.log(t.indent+"volume: "+(this.volume>>8)),t.log(t.indent+"matrix: "+this.matrix.join(", ")),t.log(t.indent+"layer: "+this.layer),t.log(t.indent+"alternate_group: "+this.alternate_group),t.log(t.indent+"width: "+this.width),t.log(t.indent+"height: "+this.height)};var MP4Box={createFile:function(t,e){t=void 0===t||t,e=new ISOFile(e);return e.discardMdatData=!t,e}};"undefined"!=typeof exports&&(exports.createFile=MP4Box.createFile);
