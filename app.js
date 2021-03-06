var http = require('http');
var deepcopy = require('deepcopy');
var querystring = require('querystring');
var langPairs = require('./langPairs.json');
var path = require('path');
var bodyParser = require('body-parser');
var cluster = require('cluster');
var express = require('express');
var morgan = require('morgan');

// Code to run if we're in the master process
if (cluster.isMaster) {

    // Count the machine's CPUs
    var cpuCount = require('os').cpus().length;

    // Create a worker for each CPU
    for (var i = 0; i < cpuCount; i += 1) {
        cluster.fork();
    }

    // Listen for dying workers
    cluster.on('exit', function (worker) {

        // Replace the dead worker, we're not sentimental
        console.log('Worker ' + worker.id + ' died :(');
        cluster.fork();

    });

// Code to run if we're in a worker process
} else {

    // Create a new Express application
    var app = express();
    app.enable('trust proxy');
    app.use(bodyParser.urlencoded({ extended: true }));
    app.use(morgan('combined'))

    app.get('/', function (req, res) {
      res.sendFile(path.join(__dirname, './', 'index.html'));
    });

    app.use("/images", express.static(__dirname + '/images'));
    app.use("/rules", express.static(__dirname + '/rules'));
    app.use("/fonts", express.static(__dirname + '/fonts'));
    app.use("/css", express.static(__dirname + '/css'));
    app.use("/js", express.static(__dirname + '/js'));

    function callAPI(src, tgt, start, end, userParams, result, result_b64, res) {
        var api = langPairs[src][tgt][start];
        var params = deepcopy(api.params);
        params.src_lang = src;
        params.tgt_lang = tgt;
        Object.keys(userParams).forEach(function(key) {
              params[key] = userParams[key];
        });
        /* If a particular module wants input from module(s) not occurring
         * strictly just before it (sequentially), then look at the 'depsOn'
         * field of that module in the json and, if the dependency is single,
         * fill params.data, otherwise fill each input as a post parameter,
         * like params.input1, params.input2. In the latter case, the internal
         * module has to be intelligent enough to interpret multiple POST
         * parameters suitably */
        if (params.depsOn) {
            for (var i in params.depsOn) {
                var dep = params.depsOn[i];
                /* First, check in result_b64 hash. If not found, then user
                 * is expected to pass the parameter */
                if (result_b64[dep]) {
                    params[dep] = result_b64[dep];
                } else {
                    params[dep] = new Buffer(params[dep]).toString('base64');
                }
            }
            if (params.depsOn.length == 1) {
                params.data = params[params.depsOn[0]];
            }
        }
        var postData = querystring.stringify(params);
        var options = {
              hostname: 'localhost',
              port: 5000,
              path: '/' + api.funcName,
              method: 'POST',
              headers: {
                  'Content-Type': 'application/x-www-form-urlencoded',
                  'Content-Length': postData.length
              }
        };
        start += 1;
        callback = function(response) {
         var str = ''
         response.setEncoding('utf8');
         response.on('data', function (chunk) {
           str += chunk;
         });
         response.on('end', function () {
           result[api.funcName + "-" + start] = new Buffer(str, 'base64').toString();
           result_b64[api.funcName] = str;
           if (start == end) {
              res.send(result);
           } else {
             userParams = {};
             userParams.data = str;
             callAPI(src, tgt, start, end, userParams, result, result_b64, res);
           }
         });
       }
       var httpreq = http.request(options, callback);

       httpreq.write(postData);
       httpreq.end();
    }

    app.get('/:src/:tgt/', function (req, res) {
       var src = req.params.src,
           tgt = req.params.tgt;
        res.send("" +langPairs[src][tgt].length);
    });

    app.post('/:src/:tgt/:start/:end', function (req, res) {
       var src = req.params.src,
           tgt = req.params.tgt,
           start = Number(req.params.start),
           end = Number(req.params.end);

       //console.log("Request received by worker:" + cluster.worker.id);

       /* Backward compatibility: User can pass sentence in any of the param
        * keys: {data, input} */
       var data = req.body.data || req.body.input;
       if (data) {
           req.body.data = new Buffer(data).toString('base64');
       }

       if (!langPairs[src][tgt]) {
           res.send('{"Error": "Invalid Language Pair"}');
       }

       if (start <= end) {
            callAPI(src, tgt, start - 1, end, req.body, {}, {}, res);
       } else {
            res.send('{"Error": "Invalid Request"}');
       }
    });

    app.get('/langpairs', function (req, res) {
        var lp = {};
        for (var src in langPairs) {
            lp[src] = [];
                for (var tgt in langPairs[src]) {
                    lp[src].push(tgt);
                }
        }
        res.send(lp);
    });

    app.get('/:src/:tgt/modules', function (req, res) {
        var modules = [];
        var src = req.params.src,
            tgt = req.params.tgt;
        for (var module in langPairs[src][tgt]) {
            modules.push(langPairs[src][tgt][module]['funcName']);
        }
        res.send(modules);
    });

    // Bind to a port
    app.listen(3000);

    console.log('Worker ' + cluster.worker.id + ' running!');
}
