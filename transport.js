/* Copyright (c) 2013-2014 Richard Rodger, MIT License */
"use strict";


var buffer = require('buffer')
var util   = require('util')
var net    = require('net')
var stream = require('stream')


var _           = require('underscore')
var patrun      = require('patrun')
var gex         = require('gex')
var connect     = require('connect')
var request     = require('request')
var lrucache    = require('lru-cache')
var reconnect   = require('reconnect-net')



module.exports = function( options ) {
  var seneca = this
  var plugin = 'transport'

  var so = seneca.options()


  options = seneca.util.deepextend({
    msgprefix: 'seneca_',
    callmax:   1111,
    msgidlen:  12,

    tcp: {
      type:     'tcp',
      host:     'localhost',
      port:     10101,
      timeout:  so.timeout ? so.timeout-555 :  22222,
    },

    web: {
      type:     'web',
      port:     10201,
      host:     'localhost',
      path:     '/act',
      protocol: 'http',
      timeout:  so.timeout ? so.timeout-555 :  22222,
    },

  },options)
  


  // Pending callbacks for all transports.
  var callmap = lrucache( options.callmax )


  seneca.add({role:plugin,cmd:'inflight'}, cmd_inflight)

  seneca.add({role:plugin,cmd:'listen'}, cmd_listen)
  seneca.add({role:plugin,cmd:'client'}, cmd_client)

  seneca.add({role:plugin,hook:'listen',type:'tcp'}, hook_listen_tcp)
  seneca.add({role:plugin,hook:'client',type:'tcp'}, hook_client_tcp)

  seneca.add({role:plugin,hook:'listen',type:'web'}, hook_listen_web)
  seneca.add({role:plugin,hook:'client',type:'web'}, hook_client_web)

  // Legacy api.
  seneca.add({role:plugin,hook:'listen',type:'direct'}, hook_listen_web)
  seneca.add({role:plugin,hook:'client',type:'direct'}, hook_client_web)



  function cmd_inflight( args, done ) {
    var inflight = {}
    callmap.forEach( function(v,k) {
      inflight[k] = v
    })
    done( null, inflight )
  }

  
  function cmd_listen( args, done ) {
    var seneca = this

    var listen_config = parseConfig(args)
    var listen_args  = 
          seneca.util.clean(
            _.omit(
              _.extend({},listen_config,{role:plugin,hook:'listen'}),'cmd'))

    if( handle_legacy_types(listen_args.type,done) ) {
      seneca.act( listen_args, done )
    }
  }



  function cmd_client( args, done ) {
    var seneca = this

    var client_config = parseConfig(args)
    var client_args   = 
          seneca.util.clean(
            _.omit(
              _.extend({},client_config,{role:plugin,hook:'client'}),'cmd'))


    if( handle_legacy_types(client_args.type,done) ) {
      seneca.act( client_args, done )
    }
  }


  function handle_legacy_types(type,done) {
    var ok = false

    // TODO: this type of code should have an easier idiom

    if( 'pubsub' == type ) {
      done(seneca.fail('plugin-needed',{name:'seneca-redis-transport'}))
    }
    else if( 'queue' == type ) {
      done(seneca.fail('plugin-needed',{name:'seneca-beanstalkd-transport'}))
    }
    else ok = true;

    return ok;
  }


  function hook_listen_tcp( args, done ) {
    var seneca         = this
    var type           = args.type
    var listen_options = seneca.util.clean(_.extend({},options[type],args))
    
    function make_msger() {
      var msger = new stream.Duplex({objectMode:true})
      msger._read = function() {}
      msger._write = function( data, enc , done ) {
        var stream_instance = this

        handle_request( seneca, data, listen_options, function(out) {
          if( null == out ) return done();
          stream_instance.push(out)
          return done();
        })
      }
      return msger
    }

    var listen = net.createServer(function(connection) {
      seneca.log.info('listen', 'connection', listen_options, seneca, 
                      'remote', connection.remoteAddress, connection.remotePort)
      connection
        .pipe(json_parser_stream())
        .pipe(make_msger())
        .pipe(json_stringify_stream())
        .pipe(connection)

      connection.on('error',function(err){
        console.log(err)
      })
    })

    listen.on('listening', function() {
      seneca.log.info('listen', 'open', listen_options, seneca)
      done(null,listen)
    })

    listen.on('error', function(err) {
      seneca.log.error('listen', 'net-error', listen_options, seneca, err.stack||err)
    })

    listen.on('close', function() {
      seneca.log.info('listen', 'close', listen_options, seneca)
      done(null,listen)
    })

    listen.listen( listen_options.port, listen_options.host )
  }


  function hook_client_tcp( args, clientdone ) {
    var seneca         = this
    var type           = args.type
    var client_options = seneca.util.clean(_.extend({},options[type],args))

    make_client( make_send, client_options, clientdone )


    function make_send( spec, topic, send_done ) {
      seneca.log.debug('client', type, 'send-init', 
                       spec, topic, client_options, seneca)

      function make_msger() {
        var msger = new stream.Duplex({objectMode:true})
        msger._read = function() {}
        msger._write = function( data, enc, done ) {
          handle_response( seneca, data, client_options )
          return done();
        }
        return msger;
      }

      var msger = make_msger()

      reconnect( function(client) {
        client
          .pipe( json_parser_stream() )
          .pipe( msger )
          .pipe( json_stringify_stream() )
          .pipe( client )

      }).on('connect', function() {
          seneca.log.debug('client', type, 'connect', 
                           spec, topic, client_options, seneca)

      }).on('reconnect', function() {
          seneca.log.debug('client', type, 'reconnect', 
                           spec, topic, client_options, seneca)

      }).on('disconnect', function(err) {
          seneca.log.debug('client', type, 'disconnect', 
                           spec, topic, client_options, seneca, 
                           (err&&err.stack)||err)

      }).connect({
        port: client_options.port, 
        host: client_options.host
      })

      send_done( null, function( args, done ) {
        var outmsg = prepare_request( seneca, args, done )
        msger.push( outmsg )
      })
    }
  }


  function json_parser_stream() {
    var json_parser = new stream.Duplex({objectMode:true})
    json_parser.linebuf = []
    json_parser._read   = function() {}
    json_parser._write  = function(data,enc,done) {
      var str     = ''+data
      var endline = -1
      var remain  = 0

      while( -1 != (endline = str.indexOf('\n',remain)) ) {
        this.linebuf.push( str.substring(remain,endline) )
        var jsonstr = this.linebuf.join('')

        this.linebuf.length = 0
        remain = endline+1

        if( '' == jsonstr ) {
          return done();
        }

        var data = parseJSON( seneca, 'stream', jsonstr )

        if( data ) {
          this.push(data)        
        }
      }

      if( -1 == endline ) {
        this.linebuf.push(str.substring(remain))
      }

      return done();
    }

    return json_parser;
  }


  function json_stringify_stream() {
    var json_stringify = new stream.Duplex({objectMode:true})
    json_stringify._read = function() {}
    json_stringify._write = function( data, enc, done ) {
      var out = stringifyJSON( seneca, 'stream', data )
    
      if( out ) {
        this.push(out+'\n')        
      }

      done()
    }

    return json_stringify;
  }
  

  function hook_listen_web( args, done ) {
    var seneca         = this
    var type           = args.type
    var listen_options = seneca.util.clean(_.extend({},options[type],args))

    var app = connect()
    app.use( connect.timeout( listen_options.timeout ) )
    app.use( connect.responseTime() )

    // query params get injected into args
    // let's you use a GET for debug
    // GETs can have side-effects, this is not a web server, or a REST API
    app.use( connect.query() )

    app.use( function( req, res, next ) {
      var buf = []
      req.setEncoding('utf8')
      req.on('data', function(chunk) { buf.push(chunk) })
      req.on('end', function() {
        try {
          var bufstr = buf.join('')
          req.body = _.extend(
            {},
            0 < bufstr.length ? parseJSON(seneca,'req-body',bufstr) : {},
            req.query||{} )

          next();
        } 
        catch (err) {
          err.body   = err.message+': '+bufstr
          err.status = 400
          next(err)
        }
      })
    })

    
    app.use( function( req, res, next ) {
      if( 0 !== req.url.indexOf(listen_options.path) ) return next();

      var data = {
        id:     req.headers['seneca-id'],
        kind:   'act',
        origin: req.headers['seneca-origin'],
        time: {
          client_sent: req.headers['seneca-time-client-sent'],
        },
        act:   req.body,
      }

      handle_request( seneca, data, listen_options, function(out) {
        var outjson = "{}"
        if( null != out ) {
          outjson = stringifyJSON(seneca,'listen-web',out.res)
        }

        var headers = {
          'Content-Type':   'application/json',
          'Cache-Control':  'private, max-age=0, no-cache, no-store',
          'Content-Length': buffer.Buffer.byteLength(outjson),
        }
        
        headers['seneca-id']     = out.id
        headers['seneca-kind']   = 'res'
        headers['seneca-origin'] = out.origin
        headers['seneca-accept'] = seneca.id
        headers['seneca-time-client-sent'] = out.time.client_sent
        headers['seneca-time-listen-recv'] = out.time.listen_recv
        headers['seneca-time-listen-sent'] = out.time.listen_sent
        
        res.writeHead( 200, headers )
        res.end( outjson )
      })
    })

    seneca.log.info('listen', listen_options, seneca)
    var listen = app.listen( listen_options.port, listen_options.host )

    done(null,listen)
  }


  function hook_client_web( args, clientdone ) {
    var seneca         = this
    var type           = args.type
    var client_options = seneca.util.clean(_.extend({},options[type],args))

    make_client( make_send, client_options, clientdone )

    function make_send( spec, topic, send_done ) {
      var fullurl = 
            'http://'+client_options.host+':'+
            client_options.port+client_options.path

      seneca.log.debug('client', 'web', 'send', spec, topic, client_options, 
                       fullurl, seneca)
      
      send_done( null, function( args, done ) {
        var data = prepare_request( this, args, done )

        var headers = {
          'seneca-id':               data.id, 
          'seneca-kind':             'req', 
          'seneca-origin':           seneca.id, 
          'seneca-time-client-sent': data.time.client_sent
        }

        var reqopts = {
          url:     fullurl,
          json:    args,
          headers: headers,
        }

        request.post( reqopts, function(err,response,body) {

          var data = {
            kind:  'res',
            res:   body,
            error: err
          }

          if( response ) {
            data.id     = response.headers['seneca-id'],
            data.origin = response.headers['seneca-origin'],
            data.accept = response.headers['seneca-accept'],
            data.time = {
              client_sent: response.headers['seneca-time-client-sent'],
              listen_recv: response.headers['seneca-time-listen-recv'],
              listen_sent: response.headers['seneca-time-listen-sent'],
            }
          }

          handle_response( seneca, data, client_options )
        })
      })
    }
  }  


  function parseConfig( args ) {
    //console.log('pc',args)
    var out = {}

    var config = args.config || args

    if( _.isArray( config ) ) {
      var arglen = config.length

      if( 0 === arglen ) {
        out.port = base.port
        out.host = base.host
        out.path = base.path
      }
      else if( 1 === arglen ) {
        if( _.isObject( config[0] ) ) {
          out = config[0]
        }
        else {
          out.port = parseInt(config[0])
          out.host = base.host
          out.path = base.path
        }
      }
      else if( 2 === arglen ) {
        out.port = parseInt(config[0])
        out.host = config[1]
        out.path = base.path
      }
      else if( 3 === arglen ) {
        out.port = parseInt(config[0])
        out.host = config[1]
        out.path = config[2]
      }

    }
    else out = config;

    // Default transport is tcp
    out.type = out.type || 'tcp'

    //out.type = null == out.type ? base.type : out.type

    if( 'direct' == out.type ) {
      out.type = 'tcp'
    }

    var base = options[out.type] || {}
    //console.log('base',base)

    out = _.extend({},base,out)

    if( 'web' == out.type || 'tcp' == out.type ) {
      out.port = null == out.port ? base.port : out.port 
      out.host = null == out.host ? base.host : out.host
      out.path = null == out.path ? base.path : out.path
    }

    return out
  }


  // only support first level
  // interim measure - deal with this in core seneca act api
  // allow user to specify operations on result
  function handle_entity( raw ) {
    raw = _.isObject( raw ) ? raw : {}
    
    if( raw.entity$ ) {
      return seneca.make$( raw )
    }
    else {
      _.each( raw, function(v,k) {
        if( _.isObject(v) && v.entity$ ) {
          raw[k] = seneca.make$( v )
        }
      })
      return raw
    }
  }


  function resolve_pins( opts ) {
    var pins = opts.pin || opts.pins
    if( pins ) {
      pins = _.isArray(pins) ? pins : [pins]
    }
    return pins
  }


  // can handle glob expressions :)
  function make_argspatrun( pins ) {
    var argspatrun = patrun(function(pat,data) {
      var gexers = {}
      _.each(pat, function(v,k) {
        if( _.isString(v) && ~v.indexOf('*') ) {
          delete pat[k]
          gexers[k] = gex(v)
        }
      })

      // handle previous patterns that match this pattern
      var prev = this.list(pat)
      var prevfind = prev[0] && prev[0].find
      var prevdata = prev[0] && this.findexact(prev[0].match)

      return function(args,data) {
        var out = data
        _.each(gexers,function(g,k) {
          var v = null==args[k]?'':args[k]
          if( null == g.on( v ) ) { out = null }
        })

        if( prevfind && null == out ) {
          out = prevfind.call(this,args,prevdata)
        }

        return out
      }
    })

    _.each( pins, function( pin ) {
      var spec = { pin:pin }
      argspatrun.add(pin,spec)
    })

    return argspatrun
  }


  function resolvetopic( opts, spec, args ) {
    var msgprefix = opts.msgprefix
    if( !spec.pin ) return function() { return msgprefix+'any' }

    var topicpin = _.clone(spec.pin)

    var topicargs = {}
    _.each(topicpin, function(v,k) { topicargs[k]=args[k] })

    return msgprefix+(util.inspect(topicargs).replace(/[^\w\d]/g,'_'))
  }


  function make_resolvesend( opts, sendmap, make_send ) {
    return function( spec, args, done ) {
      var topic = resolvetopic(opts,spec,args)
      var send = sendmap[topic]
      if( send ) return done(null,send);

      make_send(spec,topic,function(err,send){
        if( err ) return done(err)
        sendmap[topic] = send
        done(null,send)
      })
    }
  }


  function make_anyclient( opts, make_send, done ) {
    make_send( {}, opts.msgprefix+'any', function( err, send ) {
      if( err ) return done(err);
      if( !_.isFunction(send) ) return done(seneca.fail('null-client',{opts:opts}));

      done( null, {
        match: function( args ) { 
          return !this.has(args)
        },
        send: function( args, done ) {
          send.call(this,args,done)
        }
      })
    })
  }


  function make_pinclient( resolvesend, argspatrun, done ) {  
    done(null, {
      match: function( args ) {
        var match = !!argspatrun.find(args)
        return match
      },
      send: function( args, done ) {
        var spec = argspatrun.find(args)
        resolvesend(spec,args,function(err, send){
          if( err ) return done(err);
          send.call(this,args,done)
        })
      }
    })
  }


  function prepare_response( seneca, input ) {
    return {
      id:     input.id,
      kind:   'res',
      origin: input.origin,
      accept: seneca.id,
      time: { 
        client_sent:(input.time&&input.time.client_sent), 
        listen_recv:Date.now() 
      },
    }
  }


  function update_output( output, err, out ) {
    output.res = out

    if( err ) {
      output.error  = err
      output.input = data
    }

    output.time.listen_sent = Date.now()
  }


  function catch_act_error( seneca, e, listen_options, input, output ) {
    seneca.log.error('listen', 'act-error', listen_options, e.stack || e )
    output.error = e
    output.input = input
  }


  function listen_topics( seneca, args, listen_options, do_topic ) {
    var msgprefix = listen_options.msgprefix
    var pins      = resolve_pins( args )

    if( pins ) {
      _.each( seneca.findpins( pins ), function(pin) {
        var topic = msgprefix + util.inspect(pin).replace(/[^\w\d]/g,'_')
        do_topic( topic )
      })
    }
    else {
      do_topic( msgprefix+'any' )
    }
  }


  function handle_response( seneca, data, client_options ) {
    data.time = data.time || {}
    data.time.client_recv = Date.now()

    if( 'res' != data.kind ) {
      return seneca.log.error('client', 'invalid-kind', client_options, 
                       seneca, data)
    }

    if( null == data.id ) {
      return seneca.log.error('client', 'no-message-id', client_options, 
                              seneca, data);
    }

    var callmeta = callmap.get(data.id)

    if( callmeta ) {
      callmap.del( data.id )
    }
    else {
      seneca.log.error('client', 'unknown-message-id', client_options, 
                       seneca, data);
      return false;
    }

    var err = null
    if( data.error ) {
      err = new Error( data.error.message )
      err.details = data.error.details
      err.raw     = data.error
    }
    
    var result = handle_entity(data.res)

    try {
      callmeta.done( err, result ) 
    }
    catch(e) {
      seneca.log.error('client', 'callback-error', client_options, 
                       seneca, data, e.stack||e)
    }

    return true;
  }


  function prepare_request( seneca, args, done ) {
    var callmeta = {
      args: args,
      done: _.bind(done,seneca),
      when: Date.now()
    }
    callmap.set(args.actid$,callmeta) 

    var output = {
      id:     args.actid$,
      kind:   'act',
      origin: seneca.id,
      time:   { client_sent:Date.now() },
      act:    args,
    }

    return output;
  }


  function handle_request( seneca, data, listen_options, respond ) {
    if( null == data ) return respond(null);

    if( 'act' != data.kind ) {
      seneca.log.error('listen', 'invalid-kind', listen_options, 
                       seneca, data)
      return respond(null);
    }

    if( null == data.id ) {
      seneca.log.error('listen', 'no-message-id', listen_options, 
                       seneca, data)
      return respond(null);
    }

    if( data.error ) {
      seneca.log.error('listen', 'data-error', listen_options, 
                       seneca, data )
      return respond(null);
    }

    var output = prepare_response( seneca, data )
    var input  = handle_entity( data.act )

    try {
      seneca.act( input, function( err, out ) {
        update_output(output,err,out)
          
        respond(output)
      })
    }
    catch(e) {
      catch_act_error( seneca, e, listen_options, data, output )
      respond(output)
    }
  }


  function make_client( make_send, client_options, clientdone ) {
    var pins = resolve_pins( client_options )
    seneca.log.info( 'client', client_options, pins||'any', seneca )

    if( pins ) {
      var argspatrun  = make_argspatrun( pins )
      var resolvesend = make_resolvesend( client_options, {}, make_send )

      make_pinclient( resolvesend, argspatrun, function( err, send ) {
        if( err ) return clientdone(err);
        clientdone( null, send )
      })
    }
    else {
      make_anyclient( client_options, make_send, function( err, send ) {
        if( err ) return clientdone(err);
        clientdone( null, send )
      })
    }
  }


  function parseJSON( seneca, note, str ) {
    if( str ) {
      try {
        return JSON.parse( str )
      }
      catch( e ) {
        seneca.log.error( 'json-parse', note, str )
      }
    }
  }


  function stringifyJSON( seneca, note, obj ) {
    if( obj ) {
      try {
        return JSON.stringify( obj )
      }
      catch( e ) {
        seneca.log.error( 'json-stringify', note, obj )
      }
    }
  }


  var transutils = {

    // listen
    handle_request:   handle_request,
    prepare_response: prepare_response,

    // client
    prepare_request:  prepare_request,
    handle_response:  handle_response,

    // utility
    handle_entity:    handle_entity,
    update_output:    update_output,
    catch_act_error:  catch_act_error,
    listen_topics:    listen_topics,
    make_anyclient:   make_anyclient,
    resolve_pins:     resolve_pins,
    make_argspatrun:  make_argspatrun,
    make_resolvesend: make_resolvesend,
    make_pinclient:   make_pinclient,
    make_client:      make_client,
    parseJSON:        parseJSON,
    stringifyJSON:    stringifyJSON,
  }


  return {
    name:      plugin,
    exportmap: { utils: transutils },
    options:   options
  }
}
