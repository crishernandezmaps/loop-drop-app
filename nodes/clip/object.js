var Struct = require('@mmckegg/mutant/struct')
var Property = require('lib/property')
var watch = require('@mmckegg/mutant/watch')
var resolve = require('path').resolve
var computed = require('@mmckegg/mutant/computed')
var pull = require('pull-stream')
var toPcm = require('lib/to-pcm')

module.exports = AudioTimelineClip

function AudioTimelineClip (context) {
  var fullDuration = Property(0)
  var preloadTime = 5
  var segments = null
  var loadingMeta = false

  var obs = Struct({
    startOffset: Property(0),
    duration: Property(),
    flags: Property([]),
    src: Property()
  })

  obs.cuePoints = Property([])
  obs.context = context
  obs.loading = Property(false)

  var masterOutput = context.audio.createGain()
  masterOutput.connect(context.output)

  obs.startOffset.max = fullDuration
  obs.duration.max = computed([fullDuration, obs.startOffset], function (fullDuration, startOffset) {
    if (fullDuration) {
      return fullDuration - startOffset
    } else {
      return 0
    }
  })
  obs.duration.resolved = computed([obs.duration.max, obs.duration], function (max, duration) {
    return Math.min(max, duration || max)
  })

  obs.resolved = Struct({
    duration: obs.duration.resolved,
    startOffset: obs.startOffset,
    cuePoints: obs.cuePoints,
    flags: obs.flags,
    src: obs.src
  })

  obs.position = Property(0)

  var lastPath = null
  obs.src(function (value) {
    // preload
    var path = resolve(context.cwd, value)
    if (path !== lastPath) {
      loadingMeta = true
      refreshLoading()

      context.fs.readFile(path, 'utf8', function (err, result) {
        if (!err) {
          var data = JSON.parse(result)
          var offset = context.audio.sampleRate < data.sampleRate ? -(1 / context.audio.sampleRate) : 0
          var pos = 0
          segments = data.segments.map(function (segment, i) {
            var duration = segment.duration + offset
            var part = [segment.src, pos, pos + duration]
            pos += duration
            return part
          })
          fullDuration.set(pos)
        }
        loadingMeta = false
        refreshLoading()
        if (err) {
          throw err
        }
      })

      // cue points
      var timePath = path + '.time'
      obs.cuePoints.set(null)
      context.fs.readFile(timePath, function (err, buffer) {
        if (!err) {
          obs.cuePoints.set(new Float32Array(new Uint8Array(buffer).buffer))
        }
      })
    }
  })

  var queue = []

  var releaseScheduler = context.scheduler(function (schedule) {
    for (var i = queue.length - 1; i >= 0; i--) {
      var item = queue[i]
      var stopAt = item.at + item.duration
      var to = schedule[0] + schedule[1]
      if (!item.file && item.at - preloadTime <= schedule[0]) {
        load(item)
      } else if (stopAt + preloadTime <= to) {
        unload(item)
        queue.splice(i, 1)
      }
    }
  })

  obs.start = function (at, timeOffset, duration) {
    var time = at
    var remaining = duration
    var cues = getCueList(timeOffset, duration)
    cues.forEach(cue => {
      queue.push({
        at: time,
        src: cue[0],
        from: cue[1],
        duration: cue[2] - cue[1],
        player: null,
        loading: false
      })
      time += cue[2] - cue[1]
    })
  }

  obs.stop = function (at) {
    for (var i = queue.length - 1; i >= 0; i--) {
      var item = queue[i]
      if (item.player && at < item.at + item.duration) {
        item.player.stop(at)
      }
      if (item.at + item.duration > at) {
        unload(item)
        queue.splice(i, 1)
      }
    }
  }

  obs.destroy = function () {
    releaseScheduler && releaseScheduler()
    releaseScheduler = null
    while (queue.length) {
      unload(queue.pop())
    }
  }

  obs.pull = function (timeOffset, duration) {
    return pull(
      pull.values(getCueList(timeOffset, duration)),
      pull.asyncMap((cue, cb) => {
        context.fs.readFile(context.fileObject.resolvePath(cue[0]), (err, result) => {
          if (err) return cb(err)
          context.audio.decodeAudioData(result.buffer, (audioData) => {
            var start = Math.floor(cue[1] * audioData.sampleRate)
            var end = Math.floor(cue[2] * audioData.sampleRate)
            toPcm([
              audioData.getChannelData(0).subarray(start, end),
              audioData.getChannelData(1).subarray(start, end)
            ], cb)
          }, cb)
        })
      })
    )
  }

  return obs

  // scoped

  function getCueList (timeOffset, duration) {
    var result = []
    if (timeOffset == null) timeOffset = 0
    if (duration == null) duration = obs.duration.resolved() - timeOffset
    duration = Math.min(duration, obs.duration.resolved() - timeOffset)
    var startOffset = timeOffset + obs.startOffset()
    var endOffset = startOffset + duration
    var remaining = duration
    if (segments) {
      for (var i = 0; i < segments.length; i++) {
        var segment = segments[i]
        if (startOffset < segment[2]) {
          var from = Math.max(startOffset - segment[1], 0)
          var to = Math.min(segment[2], endOffset) - segment[1]
          if (to > from) {
            result.push([segment[0], from, to])
          }
          remaining = endOffset - segment[2]
          if (remaining <= 0) {
            break
          }
        }
      }
    }
    return result
  }

  function load (item) {
    item.file = context.nodes.AudioBuffer(context)
    item.file.set({src: item.src})
    item.loading = true
    refreshLoading()

    watch(item.file.currentValue, function (buffer) {
      if (buffer && !item.player) {
        item.loading = false
        item.player = context.audio.createBufferSource()
        item.player.connect(masterOutput)
        var loadTime = context.audio.currentTime
        item.player.buffer = buffer
        if (item.at < loadTime) {
          // loaded too late, oh well
          var offset = loadTime - item.at
          item.player.start(loadTime, item.from + offset, item.duration - offset)
        } else {
          item.player.start(item.at, item.from, item.duration)
        }
        refreshLoading()
      }
    })
  }

  function unload (item) {
    item.loading = false
    if (item.file) {
      item.file.destroy()
      item.file = null
    }
    if (item.player) {
      item.player.stop()
      item.player.disconnect()
      item.player = null
    }
    refreshLoading()
  }

  function refreshLoading () {
    var loading = queue.some(item => item.loading) || loadingMeta
    if (loading && !obs.loading()) {
      obs.loading.set(true)
    } else if (!loading && obs.loading()) {
      obs.loading.set(false)
    }
  }
}
