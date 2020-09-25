const {Midi, MidiIn, MidiOut} = require('j5-midi')
const ZoomUtilityPatch = require('zoom-ms-utility/js/apatch')
const ZoomUtilityAllFx = require('zoom-ms-utility/js/effectslist')
const fs = require('fs')

const ZOOM = {
    ENABLE_MESSAGE: [0xf0,0x52,0x00,0x58,0x50,0xf7],
    FX_ON: 0,
    TUNER: 74,
    EMPTY_PATCH: Array(6).fill([1].concat(Array(10).fill(0))),
    MS_60_ID: 88
}

class ZoomMultistomp {

    constructor(opts) {
        this.opts = opts = Object.assign({}, {
            patchNumber: 48,
            fx: ["T Scream", "RC Boost"],
            tunerEvent: "midi.cc.*.31",
            patchEvent: "midi.cc.*",
            patchEventStart: 20,
        }, opts)

    this.controller = opts.controller || new MidiIn({pattern: /.*/})
        this.zoomPedalInput = new MidiIn({pattern: /Zoom/ig})
        this.zoomPedal = new MidiOut({pattern: /Zoom/ig}).rtmSend(ZOOM.ENABLE_MESSAGE)
        this.patch = Object.assign(new ZoomUtilityPatch(), {name: "j5alive"})
        this.effects = {}
        this.overrides = {}
        if (opts.overridesFile) {
            let overrides = {}
            let contents = "<failed>"
            try {
                contents = fs.readFileSync(opts.overridesFile).toString()
                overrides = JSON.parse(contents)
            } catch (e) {
                console.error('Error loading overrides file', opts.overridesFile, 'contents:', contents, e)
            }
            Object.assign(this.overrides, overrides)
        }
        this.lastFx = null

        opts.fx.forEach(name => this.findEffect(name))
        this.zoomPedal.send(Midi.program(opts.patchNumber))
        this.bindController(opts)
        this.applyOverrides()
    }

    bindController(opts) {
        this.zoomPedalInput.on('sysex', data => {
            if (this.lastFx && data.length == 10) {
                let fx = this.effects[this.lastFx].fx
                let pIndex = data[6] - 2
                if (pIndex >= 0 && fx.param[pIndex]) {
                    let key = `${fx.name}.${pIndex}.${fx.param[pIndex].name}`
                    console.log(key, data[7])
                    this.overrides[key] = data[7]
                    this.applyOverrides()
                }
            }
        })
        this.zoomPedalInput.on(opts.tunerEvent, msg => zoom.send(Midi.cc(ZOOM.TUNER, 0, msg.value)))
        Object.values(this.effects).forEach((fx, index) => {
            this.controller.on(`${opts.patchEvent}.${opts.patchEventStart + index}`, this.selectHandler(index, fx))
        })
        this.zoomPedal.send(Midi.cc(ZOOM.TUNER, 0, 127))
        setTimeout(() => this.zoomPedal.send(Midi.cc(ZOOM.TUNER, 0, 0)), 3000)
    }

    applyOverrides() {
        const write = () => {
            this.writeTimer = null
            if (this.opts.overridesFile) {
                fs.writeFile(this.opts.overridesFile, JSON.stringify(this.overrides, null, 2), () => {})
            }
        }
        Object.entries(this.overrides).forEach(([key, val]) => {
            let [fx, paramIndex, paramName] = key.split(".")
            if (this.effects[fx]) {
                this.effects[fx].fx.param[parseInt(paramIndex)].def = val
            }
        })
        if (this.writeTimer) {
            clearTimeout(this.writeTimer)
            this.writeTimer = setTimeout(write, 1000)
        } else {
            write()
        }
        
    }

    findEffect(name) {
        let [id, fx] = Object.entries(ZoomUtilityAllFx).find(([id, fx]) => fx.name.match(new RegExp(name, "ig")))
        this.effects[fx.name] = {id: id, name: fx.name, fx: fx, on: false }
        console.log(`Found "${fx.name}": ${id} ${fx.name} - ${fx.title}`)
    }

    buildZoomDeviceBinary(fx) {
        let deviceArray = [1, fx.id, 0,0,0, 0,0,0, 0,0,0], i = 2
        fx.fx.param.forEach(p => deviceArray[i++] = p.def)
        return deviceArray
    }

    selectHandler(index, fx) {
        return (msg) => {
            fx.on = msg.value >= 64
            this.patch.fx = ZOOM.EMPTY_PATCH.slice(0)
            let fxChainIndex = 0
            let fxChain = []
            Object.values(this.effects).forEach((fx, i) => {
                if (fx.on) {
                    if (i == index) {
                        this.patch.curfx = fxChainIndex
                    }
                    this.patch.fx[fxChainIndex] = this.buildZoomDeviceBinary(fx).slice(0)
                    fxChain.push(ZoomUtilityAllFx[this.patch.fx[fxChainIndex][1]].name)
                    fxChainIndex++
                }
            })

            if (fx.on) {
                this.lastFx = fx.name
            } else if (fxChain.length) {
                this.lastFx = fxChain[fxChain.length - 1]
            } else {
                this.lastFx = null
            }

            console.log("FX chain:", fxChain.join(', '), "Last:", this.lastFx)
            this.sendPatchBinary()
        }
    }

    sendPatchBinary() {
        this.zoomPedal.rtmSend(this.patch.MakeBin(ZOOM.MS_60_ID, ZoomUtilityAllFx))
    }

    knob(index, value) {
        this.patch.fx[this.patch.curfx][2 + index] = value
        this.sendPatchBinary()
    }

    static defaultInstance() {
        return new ZoomMultistomp({
            overridesFile: `${__dirname}/overrides.json`,
            // controller: new MidiIn({pattern: /Keith|soft.*step|sscom.*1/ig}), tunerEvent: "midi.cc.*.31", patchEvent: "midi.cc.*", patchEventStart: 20,
            controller: new MidiIn({pattern: /Launch.*MIDI/ig, momentaryToggle: [104,105,106,107,108,109]}), tunerEvent: "midi.cc.*.31", patchEvent: "midi.cc.*", patchEventStart: 104,
            fx: "AutoWah|Rc Boost|OctFuzz|Tremolo|SlapBack|Flanger|T Scream|SuperCho|Delay|Phaser".split("|"),
        })
    }
}

module.exports = ZoomMultistomp

if (require.main === module) {
    let stomp = ZoomMultistomp.defaultInstance()
    // tmp, experimenting with controlling fx parameters
    let last = null, current = null
    stomp.controller.on('midi.cc.*.21', msg => current = Math.floor(msg.value / 128 * 51))
    stomp.controller.on('midi.cc.*.22', msg => current = Math.floor(msg.value / 128 * 51))
    setInterval(() => {
        if (last != current) {
            last = current
            stomp.knob(1, last)
        }
    }, 50)
}
